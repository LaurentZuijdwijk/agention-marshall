import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Tool } from '@agentionai/agents/core';
import type { ToolInputSchema } from '@agentionai/agents/core';
import { resolveInWorkspace } from '../primitives/resolve.js';
import { atomicWrite } from '../primitives/atomic-write.js';
import { createKeyedLock } from '../primitives/keyed-lock.js';
import type { KeyedLock } from '../primitives/keyed-lock.js';
import { spawnSandboxed } from '../primitives/spawn.js';
import { parseConflicts, applyResolution, hashConflict } from '../primitives/conflicts.js';
import type { ConflictHunk, Resolution } from '../primitives/conflicts.js';
import { withApproval } from './approval.js';
import type { ToolConfig, ToolSpec } from '../types.js';

const RESOLUTIONS: readonly Resolution[] = ['ours', 'theirs', 'both'];

const CONTEXT_LINES = 3;

function safe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Refs git exposes for "the other side", checked in the order a conflict
 *  can actually arise. `REBASE_HEAD` (git ≥2.19) is what makes this correct
 *  during a rebase without special-casing it: the commit being replayed is
 *  "theirs" there even though the branch you started on is "ours" — the
 *  reverse of a normal merge — and this ref already reflects that. */
const THEIRS_REFS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REBASE_HEAD'];

async function revParse(workspaceRoot: string, ref: string): Promise<string | null> {
  const result = await spawnSandboxed('git', ['rev-parse', '--short', ref], { cwd: workspaceRoot, timeout: 5_000 });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

async function getSideCommits(workspaceRoot: string): Promise<{ ours: string | null; theirs: string | null }> {
  const ours = await revParse(workspaceRoot, 'HEAD');
  for (const ref of THEIRS_REFS) {
    const theirs = await revParse(workspaceRoot, ref);
    if (theirs) return { ours, theirs };
  }
  return { ours, theirs: null };
}

/** Paths git currently considers unmerged, relative to `workspaceRoot`. */
async function unmergedPaths(workspaceRoot: string): Promise<string[]> {
  const result = await spawnSandboxed('git', ['diff', '--name-only', '--diff-filter=U'], {
    cwd: workspaceRoot,
    timeout: 10_000,
  });
  if (result.exitCode !== 0) return [];
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

function numberedLines(lines: string[], startLine: number): string {
  if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) return '(empty)';
  const width = String(startLine + lines.length - 1).length;
  return lines.map((line, i) => `${String(startLine + i).padStart(width)} | ${line}`).join('\n');
}

function describeHunk(
  relPath: string,
  fileLines: string[],
  hunk: ConflictHunk,
  id: string,
  ours: { label: string; commit: string | null },
  theirs: { label: string; commit: string | null },
): string {
  const contextBefore = fileLines.slice(Math.max(0, hunk.startLine - 1 - CONTEXT_LINES), hunk.startLine - 1);
  const contextBeforeStart = hunk.startLine - contextBefore.length;
  const contextAfter = fileLines.slice(hunk.endLine, hunk.endLine + CONTEXT_LINES);

  const oursHeader = `--- ours${ours.commit ? ` (${ours.label || 'HEAD'} @ ${ours.commit})` : ours.label ? ` (${ours.label})` : ''} ---`;
  const theirsHeader = `--- theirs${theirs.commit ? ` (${theirs.label || 'incoming'} @ ${theirs.commit})` : theirs.label ? ` (${theirs.label})` : ''} ---`;

  const oursStart = hunk.startLine + 1;
  // theirs occupies the lines immediately before the closing `>>>>>>>` marker.
  const theirsStart = hunk.endLine - hunk.theirsText.split('\n').length;

  const parts = [
    `[${id}] ${relPath}:${hunk.startLine}-${hunk.endLine}`,
    ...(contextBefore.length ? [numberedLines(contextBefore, contextBeforeStart)] : []),
    oursHeader,
    numberedLines(hunk.oursText.split('\n'), oursStart),
    theirsHeader,
    numberedLines(hunk.theirsText.split('\n'), theirsStart),
    ...(contextAfter.length ? [numberedLines(contextAfter, hunk.endLine + 1)] : []),
  ];
  return parts.join('\n');
}

interface FoundHunk {
  relPath: string;
  resolved: string;
  hunk: ConflictHunk;
  id: string;
}

/** Sync counterpart to `unmergedPaths`, for the sync `describeResolve` approval preview. */
function readSyncUnmergedPaths(workspaceRoot: string): string[] {
  try {
    const out = execFileSync('git', ['diff', '--name-only', '--diff-filter=U'], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      timeout: 5_000,
    });
    return out.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function findHunk(workspaceRoot: string, id: string): Promise<FoundHunk | null> {
  for (const relPath of await unmergedPaths(workspaceRoot)) {
    const resolved = resolveInWorkspace(workspaceRoot, relPath);
    let content: string;
    try { content = await readFile(resolved, 'utf8'); } catch { continue; }
    for (const hunk of parseConflicts(content)) {
      if (hashConflict(relPath, hunk) === id) return { relPath, resolved, hunk, id };
    }
  }
  return null;
}

/**
 * Resolves one hunk by id: locate it, apply the choice, write the file.
 *
 * Re-locates under the file's lock rather than reusing whatever `findHunk`
 * saw before the lock was acquired — a earlier item in the same batch (or a
 * concurrent call) can have already rewritten this file. The id is
 * content-hashed, so it is still valid; only its offset may have moved.
 */
async function resolveOne(
  workspaceRoot: string,
  withFileLock: KeyedLock,
  id: string,
  choice: Resolution,
): Promise<string> {
  const found = await findHunk(workspaceRoot, id);
  if (!found) return `${id}: error — no unresolved conflict with this id. Call list_conflicts for current ids.`;

  return await withFileLock(found.resolved, async () => {
    const content = await readFile(found.resolved, 'utf8');
    const hunk = parseConflicts(content).find((h) => hashConflict(found.relPath, h) === id);
    if (!hunk) return `${id}: error — no unresolved conflict with this id. Call list_conflicts for current ids.`;

    const next = applyResolution(content, hunk, choice);
    await atomicWrite(found.resolved, next);
    return `${id}: resolved in ${found.relPath} — kept ${choice}.`;
  });
}

/**
 * Tools for resolving `git` merge/rebase/cherry-pick conflicts without an
 * agent having to hold whole files in context: `list_conflicts` hands out a
 * short content-hashed id per hunk plus enough context to judge it,
 * `resolve_conflicts` takes those ids back with a side to keep each.
 */
export function createConflictTools(config: ToolConfig): Tool<string>[] {
  const { workspaceRoot, approval } = config;
  const withFileLock = config.fileLock ?? createKeyedLock();

  const list_conflicts = new Tool<string>({
    name: 'list_conflicts',
    description:
      'List every unresolved git merge/rebase/cherry-pick conflict in the workspace, across all ' +
      'files. This is the authoritative, complete list — do not grep or read_file for conflict ' +
      'markers, this already found them all. Each hunk gets a short id, its file and line range, ' +
      'ours/theirs labels and commit ids, the full text of both sides, and a few lines of ' +
      'surrounding context — enough to judge and resolve it without opening the file. Pass the ' +
      'ids to resolve_conflicts in one call to resolve some or all of them at once.',
    inputSchema: { type: 'object', properties: {}, required: [] } satisfies ToolInputSchema,
    execute: async () => {
      try {
        const paths = await unmergedPaths(workspaceRoot);
        if (paths.length === 0) return 'No unresolved conflicts.';

        const { ours, theirs } = await getSideCommits(workspaceRoot);
        const blocks: string[] = [];

        for (const relPath of paths) {
          const resolved = resolveInWorkspace(workspaceRoot, relPath);
          let content: string;
          try { content = await readFile(resolved, 'utf8'); } catch (err) {
            blocks.push(`${relPath}: Error reading file: ${safe(err)}`);
            continue;
          }
          const fileLines = content.split('\n');
          const hunks = parseConflicts(content);
          if (hunks.length === 0) continue;
          for (const hunk of hunks) {
            const id = hashConflict(relPath, hunk);
            blocks.push(describeHunk(
              relPath,
              fileLines,
              hunk,
              id,
              { label: hunk.oursLabel, commit: ours },
              { label: hunk.theirsLabel, commit: theirs },
            ));
          }
        }

        if (blocks.length === 0) return 'No unresolved conflicts.';
        return blocks.join('\n\n');
      } catch (err) {
        return `Error: ${safe(err)}`;
      }
    },
  });

  const resolve_conflicts_spec: ToolSpec = {
    name: 'resolve_conflicts',
    description:
      'Resolve one or more conflict hunks reported by list_conflicts, in a single call — give ' +
      'every hunk you have decided on at once rather than calling this repeatedly. For each: ' +
      '"ours" or "theirs" keeps that side, "both" keeps ours then theirs with markers removed. ' +
      'Ids stay valid across the whole batch even when two hunks share a file. Trust the result: ' +
      'a hunk reported resolved is resolved, no need to read_file to confirm. If you still have ' +
      'unresolved hunks afterwards, call list_conflicts again — it reflects the current state.',
    inputSchema: {
      type: 'object',
      properties: {
        resolutions: {
          type: 'array',
          minItems: 1,
          description: 'One entry per hunk to resolve.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'The hunk id from list_conflicts' },
              choice: { type: 'string', enum: [...RESOLUTIONS], description: 'Which side(s) to keep' },
            },
            required: ['id', 'choice'],
          },
        },
      },
      required: ['resolutions'],
    },
    execute: async ({ resolutions }) => {
      try {
        const items = Array.isArray(resolutions) ? resolutions : [];
        if (items.length === 0) return 'Error: resolutions must be a non-empty array of { id, choice }.';

        const lines: string[] = [];
        for (const item of items as Array<Record<string, unknown>>) {
          const id = String(item?.id ?? '');
          const choice = String(item?.choice ?? '');
          if (!id) { lines.push('error — resolution missing an id.'); continue; }
          if (!RESOLUTIONS.includes(choice as Resolution)) {
            lines.push(`${id}: error — choice must be one of ${RESOLUTIONS.join(', ')}.`);
            continue;
          }
          lines.push(await resolveOne(workspaceRoot, withFileLock, id, choice as Resolution));
        }
        return lines.join('\n');
      } catch (err) {
        return `Error: ${safe(err)}`;
      }
    },
  };

  // Sync and best-effort: buildRequest runs before the tool body (see
  // file-tools.ts's describeWrite), so this re-does the id lookups with
  // synchronous reads. A hunk that can no longer be found here just falls
  // back to echoing the raw request; the tool body reports that properly.
  const describeResolve = ({ resolutions }: Record<string, unknown>) => {
    const items = Array.isArray(resolutions) ? resolutions as Array<Record<string, unknown>> : [];
    const fallback = {
      toolName: 'resolve_conflicts',
      description: `Resolve ${items.length} conflict${items.length === 1 ? '' : 's'}`,
      detail: items.map((r) => `${r.id}: keep ${r.choice}`).join('\n'),
    };
    try {
      const paths = readSyncUnmergedPaths(workspaceRoot);
      const contentByPath = new Map<string, string>();
      for (const relPath of paths) {
        const resolved = resolveInWorkspace(workspaceRoot, relPath);
        try { contentByPath.set(relPath, readFileSync(resolved, 'utf8')); } catch { /* skip */ }
      }

      const blocks: string[] = [];
      for (const { id, choice } of items) {
        let found = false;
        for (const [relPath, content] of contentByPath) {
          const hunk = parseConflicts(content).find((h) => hashConflict(relPath, h) === String(id));
          if (!hunk) continue;
          found = true;
          blocks.push(
            `${relPath}:${hunk.startLine}-${hunk.endLine}, keeping ${choice}\n` +
            `--- ours (${hunk.oursLabel || 'HEAD'}) ---\n${hunk.oursText}\n` +
            `--- theirs (${hunk.theirsLabel || 'incoming'}) ---\n${hunk.theirsText}`,
          );
          break;
        }
        if (!found) blocks.push(`${id}: keep ${choice} (hunk not found)`);
      }
      if (blocks.length === 0) return fallback;
      return {
        toolName: 'resolve_conflicts',
        description: `Resolve ${items.length} conflict${items.length === 1 ? '' : 's'}`,
        detail: blocks.join('\n\n'),
      };
    } catch {
      return fallback;
    }
  };

  const resolve_conflicts = withApproval(
    resolve_conflicts_spec,
    approval,
    describeResolve,
    config.signal,
    config.caller,
    config.taskContext,
  );

  return [list_conflicts, resolve_conflicts];
}
