// ── the read gate ─────────────────────────────────────────────────────────────
//
// `read_file`, `write_file` and `edit_file` are one mechanism with three entry
// points, which is why they share a file. The invariant they hold between them:
// you may not replace a file you have not seen all of, and not if it has
// changed since you saw it. That is carried by two maps — what each path hashed
// to when it was read, and how much of it was rendered — and splitting the
// three tools apart would mean exporting those maps, which hides the coupling
// rather than removing it.

import { Tool } from '@agentionai/agents/core';
import type { ToolInputSchema } from '@agentionai/agents/core';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { resolveInWorkspace } from '../../primitives/resolve.js';
import { DEFAULT_MAX_FILE_BYTES } from '../../primitives/capped-read.js';
import { readLineWindow } from '../../primitives/line-window.js';
import { atomicWrite } from '../../primitives/atomic-write.js';
import { createKeyedLock } from '../../primitives/keyed-lock.js';
import { formatFileDiff, describeDiff } from '../../primitives/diff.js';
import { safe } from '../../primitives/tool-error.js';
import { withApproval } from '../approval.js';
import type { ToolConfig, ToolSpec, DedupeCache } from '../../types.js';

/**
 * How much of a file the last read actually showed. Seeing part of a file is
 * not enough to authorize replacing all of it — the parts never rendered would
 * be discarded by content composed from what was — so `write_file` demands
 * `'complete'`, and the two ways of falling short need different advice:
 * `'range'` is fixed by re-reading without a line range, `'over-limit'` only by
 * raising `maxFileBytes`.
 */
type ReadCoverage = 'complete' | 'range' | 'over-limit';

// Kept alongside the shared read state so it survives factories recreated for
// the same session.
const coverageByReadMap = new WeakMap<Map<string, string>, Map<string, ReadCoverage>>();

function simpleDiff(filePath: string, oldStr: string, newStr: string): string {
  const out = [`--- ${filePath}`, `+++ ${filePath}`];
  for (const l of oldStr.split('\n')) out.push(`- ${l}`);
  for (const l of newStr.split('\n')) out.push(`+ ${l}`);
  return out.join('\n');
}

function numberedLines(lines: string[], startLine: number, lastLine: number): string {
  const width = String(lastLine).length;
  return lines
    .map((line, i) => `${String(startLine + i).padStart(width)} | ${line}`)
    .join('\n');
}

/**
 * `undefined` for "not given", `null` for "given but unusable". Values below 1
 * read as unset, which is how the old truthiness check treated a literal 0.
 */
function parseLineArg(value: unknown): number | undefined | null {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const floored = Math.floor(parsed);
  return floored < 1 ? undefined : floored;
}

export function buildReadFile(
  workspaceRoot: string,
  maxFileBytes: number,
  readFiles: Map<string, string>,
  dedupeCache?: DedupeCache,
  coverageSnapshot?: Map<string, ReadCoverage>,
): Tool<string> {
  return new Tool<string>({
    name: 'read_file',
    description:
      'Read a file within the workspace. Returns content with line numbers. ' +
      'Use startLine/endLine to read a specific range. Large files are truncated.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to workspace root' },
        startLine: { type: 'number', description: 'First line to return (1-indexed, inclusive). Defaults to 1.' },
        endLine: { type: 'number', description: 'Last line to return (1-indexed, inclusive). Defaults to end of file.' },
      },
      required: ['path'],
    } satisfies ToolInputSchema,
    execute: async ({ path, startLine, endLine }) => {
      try {
        const firstArg = parseLineArg(startLine);
        const lastArg = parseLineArg(endLine);
        if (firstArg === null || lastArg === null) {
          return `Error: startLine and endLine must be numbers, got ${JSON.stringify({ startLine, endLine })}.`;
        }
        if (firstArg !== undefined && lastArg !== undefined && firstArg > lastArg) {
          return `Error: startLine ${firstArg} is after endLine ${lastArg}.`;
        }
        const isFullRead = firstArg === undefined && lastArg === undefined;
        const start = firstArg ?? 1;

        const resolved = resolveInWorkspace(workspaceRoot, String(path));
        const scan = await readLineWindow(resolved, {
          startLine: start,
          endLine: lastArg,
          maxBytes: maxFileBytes,
        });
        const { totalLines } = scan;
        const rel = relative(workspaceRoot, resolved);

        readFiles.set(resolved, scan.hash);
        // A full read that rendered every line is the only thing that
        // authorizes a wholesale overwrite; anything else says why not.
        const coverage: ReadCoverage = !isFullRead ? 'range' : scan.truncated ? 'over-limit' : 'complete';
        const coverageByPath = coverageSnapshot ?? coverageByReadMap.get(readFiles) ?? new Map<string, ReadCoverage>();
        if (!coverageSnapshot) coverageByReadMap.set(readFiles, coverageByPath);
        coverageByPath.set(resolved, coverage);

        // Dedupe: on full reads, return a lightweight marker if content unchanged.
        if (isFullRead && dedupeCache) {
          const cached = dedupeCache.get(resolved);
          if (cached && cached.hash === scan.hash) {
            return (
              `# ${rel}\n` +
              `[Unchanged since last read — ${totalLines} lines. ` +
              `Use startLine/endLine if you need a specific section.]`
            );
          }
          dedupeCache.set(resolved, { hash: scan.hash, lineCount: totalLines });
        }

        if (totalLines === 0) return `# ${rel}  (lines 0–0 of 0)\n(empty file)`;

        if (start > totalLines) {
          return `# ${rel}  (lines 0–0 of ${totalLines})\n[startLine ${start} is beyond total lines ${totalLines}]`;
        }

        const end = scan.end;
        const header = `# ${rel}  (lines ${start}–${end} of ${totalLines})`;
        // "Read another section" is real advice when lines were left off the
        // end, but not when the one line shown was itself too long — there is
        // nothing else to page to, only more of the same line.
        const truncationNotice = scan.lineClipped
          ? `\n[...line ${end} truncated — it exceeds the read limit on its own. Increase maxFileBytes to see more of it, or use search to find a specific part...]`
          : scan.truncated
            ? `\n[...file truncated — showing lines ${start}–${end} of ${totalLines} (${end - start + 1} lines). Use startLine/endLine to read other sections...]`
            : '';

        return header + '\n' + numberedLines(scan.lines, start, end) + truncationNotice;
      } catch (err) {
        return `Error: ${safe(err)}`;
      }
    },
  });
}

/**
 * The three tools that share the gate: `read_file` opens it, `write_file` and
 * `edit_file` are the only things that check it.
 */
export function createReadGateTools(
  config: ToolConfig,
  dedupeCache?: DedupeCache,
): { read_file: Tool<string>; write_file: Tool<string>; edit_file: Tool<string> } {
  const { workspaceRoot, approval, limits = {} } = config;
  const maxFileBytes = limits.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  // Shared set: read_file populates it; write_file/edit_file check it. Supplied
  // by the session when it should outlive this belt — see ToolConfig.readFiles.
  const readFiles = config.readFiles ?? new Map<string, string>();
  const readCoverage = coverageByReadMap.get(readFiles) ?? new Map<string, ReadCoverage>();
  coverageByReadMap.set(readFiles, readCoverage);

  /**
   * The file as read_file would see it, hashed — same read path, so a large
   * file's truncation does not make the two incomparable.
   *
   * `markSeen` is the whole subtlety. Hashing a file says what is in it now; it
   * does not say the caller has *seen* what is in it, and only one of the two
   * callers can claim that. `write_file` supplied the entire content, so after
   * it lands the caller has accounted for every line — `markSeen: true`, with
   * the read limit the only thing that can still leave it short of
   * `'complete'`. `edit_file` matched a unique substring and never saw the
   * rest, so it records the new hash and leaves coverage exactly as it was: a
   * ranged read followed by an edit is still a ranged read, and must not
   * unlock the wholesale overwrite the gate exists to refuse.
   */
  const fileHash = async (resolved: string, { markSeen }: { markSeen: boolean }): Promise<string> => {
    const scan = await readLineWindow(resolved, { maxBytes: maxFileBytes });
    if (markSeen) readCoverage.set(resolved, scan.truncated ? 'over-limit' : 'complete');
    return scan.hash;
  };

  // Serialises the mutating tools per path. The model batches tool calls, and
  // both write_file and edit_file read the file before writing it back, so
  // without this two calls on one path race and the loser's edit vanishes.
  // Supplied by the session when more than one belt can write — see
  // ToolConfig.fileLock.
  const withFileLock = config.fileLock ?? createKeyedLock();

  const read_file = buildReadFile(workspaceRoot, maxFileBytes, readFiles, dedupeCache, readCoverage);

  const write_file_spec: ToolSpec = {
    name: 'write_file',
    description:
      'Write content to a file in the workspace (atomic). Use this to create a new file, or to ' +
      'replace one wholesale. To change part of an existing file, prefer edit_file: targeted ' +
      'edits combine with each other, whole-file writes do not. ' +
      'If the file already exists you must read_file it first this session, and it must not have ' +
      'changed since — never issue two write_file calls for the same path at once.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to workspace root' },
        content: { type: 'string', description: 'Full content to write' },
      },
      required: ['path', 'content'],
    },
    execute: async ({ path, content }) => {
      try {
        const resolved = resolveInWorkspace(workspaceRoot, String(path));
        // Captured before the lock: what this call believes the file holds,
        // which is the state as of the caller's last read. Two writes issued
        // together both capture the read-time hash, so whichever runs second
        // finds its expectation broken instead of silently discarding the
        // first — serialising them alone cannot prevent that, because each
        // carries whole-file content composed from the same stale view.
        const expected = readFiles.get(resolved);
        return await withFileLock(resolved, async () => {
          if (existsSync(resolved)) {
            if (expected === undefined) {
              return (
                `Error: ${relative(workspaceRoot, resolved)} exists but has not been read this session. ` +
                `Call read_file first so you have the current content before overwriting it.`
              );
            }
            const coverage = readCoverage.get(resolved);
            if (coverage !== 'complete') {
              return coverage === 'over-limit'
                ? (
                  `Error: ${relative(workspaceRoot, resolved)} was only partially read because it exceeds the ` +
                  `read limit. Read the complete file (increase maxFileBytes) before replacing it wholesale; ` +
                  `use edit_file for a targeted change.`
                )
                : (
                  `Error: ${relative(workspaceRoot, resolved)} was read with startLine/endLine, so you have seen ` +
                  `only part of it and a wholesale write would discard the rest. Call read_file again without a ` +
                  `line range, or use edit_file for a targeted change.`
                );
            }
            // A comparison, not a claim about what the caller has seen — the
            // write has not happened yet. Coverage was checked just above.
            const actual = await fileHash(resolved, { markSeen: false });
            if (actual !== expected) {
              return (
                `Error: ${relative(workspaceRoot, resolved)} changed after you read it, so writing now ` +
                `would discard that change. Call read_file again and rebuild your content from the ` +
                `current version. If you meant to make several separate changes, use edit_file — ` +
                `targeted edits combine, whole-file writes do not.`
              );
            }
          }
          await atomicWrite(resolved, String(content));
          // The caller composed every line of this, so it has now seen the whole
          // file whether or not its original read was ranged.
          readFiles.set(resolved, await fileHash(resolved, { markSeen: true }));
          return `Wrote ${String(content).length} bytes to ${relative(workspaceRoot, resolved)}`;
        });
      } catch (err) {
        return `Error: ${safe(err)}`;
      }
    },
  };

  const edit_file_spec: ToolSpec = {
    name: 'edit_file',
    description:
      'Replace an exact string in a file (must appear exactly once). ' +
      'You must read_file it first this session.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to workspace root' },
        oldString: { type: 'string', description: 'Exact text to find (must be unique in the file)' },
        newString: { type: 'string', description: 'Replacement text' },
      },
      required: ['path', 'oldString', 'newString'],
    },
    execute: async ({ path, oldString, newString }) => {
      try {
        const resolved = resolveInWorkspace(workspaceRoot, String(path));
        if (!readFiles.has(resolved)) {
          return (
            `Error: ${relative(workspaceRoot, resolved)} has not been read this session. ` +
            `Call read_file first to load its current contents before editing.`
          );
        }
        return await withFileLock(resolved, async () => {
          const original = await readFile(resolved, 'utf8');
          const old = String(oldString);
          const count = original.split(old).length - 1;
          if (count === 0) {
            return `Error: oldString not found in ${path}. It must match the file exactly, including whitespace.`;
          }
          if (count > 1) return `Error: oldString appears ${count} times in ${path}. Include more surrounding text to make it unique.`;

          await atomicWrite(resolved, original.replace(old, String(newString)));
          // Deliberately no hash precondition here: edit_file re-reads and
          // matches a unique string, so two edits to different parts of one
          // file both apply and both are correct. Recording the new hash keeps
          // a later write_file honest about what it would be overwriting —
          // but `markSeen: false`, because matching a substring is not reading
          // the file, and an edit must not promote a ranged read to `'complete'`.
          readFiles.set(resolved, await fileHash(resolved, { markSeen: false }));
          return `Edited ${relative(workspaceRoot, resolved)}`;
        });
      } catch (err) {
        return `Error: ${safe(err)}`;
      }
    },
  };

  /**
   * What a reviewer is shown for a whole-file write.
   *
   * A diff against what is on disk, not a preview of the payload. The preview
   * showed the first 800 characters of the new content, so a change past that
   * point was never rendered at all — rewriting a whole file was a way to make
   * an edit that `edit_file` would have shown as a diff, and have the panel
   * display an unchanged, benign-looking prefix instead. With a diff, an
   * approval that looks empty means nothing changed.
   *
   * Read synchronously because `buildRequest` is sync and runs before the tool
   * body. The file has just been hashed by the read gate anyway, so it is warm.
   */
  const describeWrite = ({ path, content }: Record<string, unknown>) => {
    const next = String(content);
    let resolved: string;
    try {
      resolved = resolveInWorkspace(workspaceRoot, String(path));
    } catch {
      // Let the tool body report the path error; the panel just shows the ask.
      return { toolName: 'write_file', description: `Write file: ${path}`, detail: `Path: ${path}` };
    }

    if (!existsSync(resolved)) {
      return {
        toolName: 'write_file',
        description: `Create file: ${path} (${next.split('\n').length} lines)`,
        detail: `New file: ${path}\n\n${next.slice(0, 800)}${next.length > 800 ? '\n[...]' : ''}`,
      };
    }

    let current = '';
    try { current = readFileSync(resolved, 'utf8'); } catch { /* unreadable — diff against empty */ }
    const { text, stats } = formatFileDiff(String(path), current, next);
    return {
      toolName: 'write_file',
      description: `Write file: ${path}  (${describeDiff(stats)})`,
      detail: text,
      // `input` is deliberately left as the raw arguments (see ApprovalRequest):
      // `detail` is the change rendered for a human, and an automated reviewer
      // cannot work backwards from that to what is actually being written.
      // Summarising it here would shrink the judge's prompt by narrowing what
      // the judge is allowed to see, which is the wrong trade on a safety gate.
    };
  };

  const write_file = withApproval(
    write_file_spec,
    approval,
    describeWrite,
    config.signal,
    config.caller,
    config.taskContext,
  );

  const edit_file = withApproval(
    edit_file_spec,
    approval,
    ({ path, oldString, newString }) => ({
      toolName: 'edit_file',
      description: `Edit file: ${path}`,
      detail: simpleDiff(String(path), String(oldString), String(newString)),
    }),
    config.signal,
    config.caller,
    config.taskContext,
  );

  return { read_file, write_file, edit_file };
}
