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
import { applyEdits } from '../../primitives/apply-edits.js';
import type { EditRequest, EditFailure } from '../../primitives/apply-edits.js';
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

/**
 * The fallback shown when the edits cannot be located to build a real diff.
 *
 * A line-addressed edit has no `oldString` to show as the removed side, so it
 * is labelled by the range it targets instead — the panel still says what is
 * being replaced and with what, which is the point of the fallback.
 */
function simpleDiff(filePath: string, edits: readonly EditRequest[]): string {
  const out = [`--- ${filePath}`, `+++ ${filePath}`];
  for (const edit of edits) {
    if (edit.oldString === undefined) out.push(`@@ lines ${edit.startLine}-${edit.endLine} @@`);
    else for (const l of edit.oldString.split('\n')) out.push(`- ${l}`);
    for (const l of edit.newString.split('\n')) out.push(`+ ${l}`);
  }
  return out.join('\n');
}

/**
 * The requested replacements, however the caller expressed them.
 *
 * `edits[]` is the shape worth using — one call for every disjoint change to a
 * file — but the single `oldString`/`newString` pair is still accepted and
 * folded into a one-element batch. Both are live rather than one replacing the
 * other because a hard cutover breaks every existing caller at once; the
 * guidance, not the schema, is what moves models onto the batch form.
 *
 * `edits` arrives as a JSON *string* from some models rather than as an array,
 * so that is parsed rather than rejected — the alternative is a retry that
 * re-emits the entire edit body.
 */
function toEdits(input: Record<string, unknown>): EditRequest[] | undefined {
  const raw = input.edits;
  let list: unknown;
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw); } catch { return undefined; }
  } else {
    list = raw;
  }

  if (!Array.isArray(list)) {
    if (input.oldString === undefined) return undefined;
    return [{ oldString: String(input.oldString), newString: String(input.newString ?? '') }];
  }

  const edits: EditRequest[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') return undefined;
    const { oldString, newString, startLine, endLine } = item as Record<string, unknown>;
    if (oldString !== undefined) {
      edits.push({ oldString: String(oldString), newString: String(newString ?? '') });
      continue;
    }
    if (startLine !== undefined && endLine !== undefined) {
      edits.push({ startLine: Number(startLine), endLine: Number(endLine), newString: String(newString ?? '') });
      continue;
    }
    return undefined;
  }
  return edits.length ? edits : undefined;
}

/**
 * A failed edit, worded the same as it always has been for a lone edit.
 *
 * The `edits[i]: ` prefix appears only in a batch, where it is the only way to
 * say which replacement broke. Adding it unconditionally would change the
 * message a single edit has always produced for no gain.
 */
function describeFailure(failure: EditFailure, path: string, total: number): string {
  const at = total > 1 ? `edits[${failure.index}]: ` : '';
  switch (failure.reason) {
    case 'not-found':
      return `${at}oldString not found in ${path}. It must match the file exactly, including whitespace.`;
    case 'ambiguous':
      return `${at}oldString appears ${failure.count} times in ${path}. Include more surrounding text to make it unique.`;
    case 'overlap':
      return `${at}this edit overlaps another in the same call. Each edit is applied to the original file, so merge changes that touch the same region into one edit.`;
    case 'bad-range':
      return `${at}startLine/endLine is not a valid range in ${path}, which has ${failure.lineCount} lines. Use the line numbers read_file showed, 1-indexed and inclusive.`;
  }
}

/**
 * Renders file content for the model, with or without a line-number gutter.
 *
 * Off by default, and that default is the result of a measurement rather than a
 * preference. A gutter makes content easy to *refer* to and impossible to
 * *copy*: `edit_file` matches an exact string, so with `12 | ` in front of
 * every line the model cannot lift text out of what it just read — it has to
 * reconstruct it. Reading the model's own reasoning on a 28-file migration
 * showed exactly that, drafting each oldString in full inside its thinking
 * before emitting the same text again as arguments, then spending more thinking
 * repairing edits it had malformed in the process. Thinking was 55% of
 * everything it generated; the harness we compared against renders raw text and
 * spends 18%.
 *
 * The header still reports the range, so a ranged read says what it covered.
 */
function renderLines(lines: string[], startLine: number, lastLine: number, gutter: boolean): string {
  if (!gutter) return lines.join('\n');
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
  lineNumbers = false,
): Tool<string> {
  return new Tool<string>({
    name: 'read_file',
    // The run_shell pointer is here rather than only in the system prompt
    // because this is where a model decides between one call and thirty. It is
    // only honest advice because edit_file no longer requires a prior
    // read_file: content obtained any way at all is enough to edit from, so
    // the shell route costs nothing later.
    description:
      'Read one file within the workspace. ' +
      'Use startLine/endLine to read a specific range. Large files are truncated. ' +
      'For several files use one run_shell call (`grep -rl PATTERN src | xargs cat`) rather than ' +
      'calling this repeatedly — edit_file needs no prior read_file, so that output is enough to edit from.',
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

        return header + '\n' + renderLines(scan.lines, start, end, lineNumbers) + truncationNotice;
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

  const read_file = buildReadFile(workspaceRoot, maxFileBytes, readFiles, dedupeCache, readCoverage, limits.readLineNumbers ?? false);

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
      'Change a file, with one call per file: put every change you have decided on for it in edits[] ' +
      'rather than calling this repeatedly. Each oldString is exact text from the current file, ' +
      'must appear exactly once in it, and must not overlap another edit in the same call. Every ' +
      'edit applies to the file as it stands, not to the result of earlier edits in the batch. ' +
      'Keep oldString just long enough to be unique — do not pad it with unchanged lines to bridge ' +
      'distant changes; use separate entries. No prior read_file is needed: however you came by the ' +
      'text, a wrong oldString fails rather than landing in the wrong place.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to workspace root' },
        edits: {
          type: 'array',
          minItems: 1,
          description: 'Every replacement to make in this file, in one call.',
          items: {
            type: 'object',
            properties: {
              oldString: { type: 'string', description: 'Exact text to find, copied from read_file output (must be unique in the file)' },
              newString: { type: 'string', description: 'Replacement text' },
            },
            required: ['oldString', 'newString'],
          },
        },
      },
      required: ['path', 'edits'],
    },
    execute: async (input) => {
      const { path } = input;
      try {
        const resolved = resolveInWorkspace(workspaceRoot, String(path));
        const edits = toEdits(input);
        if (!edits) {
          return (
            `Error: no edits given for ${path}. Pass edits: [{ oldString, newString }, ...] ` +
            `with one entry per replacement.`
          );
        }
        if (!existsSync(resolved)) {
          return (
            `Error: ${relative(workspaceRoot, resolved)} does not exist. ` +
            `Use write_file to create it.`
          );
        }
        return await withFileLock(resolved, async () => {
          const original = await readFile(resolved, 'utf8');

          // No read requirement for an `oldString` edit, deliberately. The
          // oldString *is* the evidence: it has to occur exactly once in the
          // file as it stands, so an edit built on a guess about content the
          // caller never saw does not land quietly — it fails `not-found` or
          // `ambiguous` and says so. Requiring a prior read on top of that
          // bought no safety and cost a round trip per file, which is the
          // whole of the difference on a task that touches many files: the
          // gate made `read_file` mandatory even when the caller had already
          // seen the content another way (a shell `cat`, a search hit with
          // context, a file it had just written).
          //
          // A line-addressed edit is the opposite case and keeps the gate.
          // Line 12 is whatever line 12 currently is, so the request carries
          // no evidence at all; it is only meaningful against the exact
          // version whose numbers the caller actually saw, and a file never
          // read has no such version.
          if (edits.some(e => e.oldString === undefined)) {
            const expected = readFiles.get(resolved);
            if (expected === undefined) {
              return (
                `Error: ${relative(workspaceRoot, resolved)} has not been read this session, so its ` +
                `line numbers are not yours to rely on. Call read_file first, or address the change ` +
                `with oldString instead — that needs no prior read.`
              );
            }
            const actual = await fileHash(resolved, { markSeen: false });
            if (expected !== actual) {
              return (
                `Error: ${relative(workspaceRoot, resolved)} changed since you read it, so its line ` +
                `numbers no longer point where you think. Call read_file again and reissue the edit ` +
                `against the current line numbers, or address it with oldString instead.`
              );
            }
          }

          const result = applyEdits(original, edits);
          if (!result.ok) {
            // Every failure at once: a batch reported one at a time costs a
            // round trip per bad edit, and the caller can usually fix them
            // together once it can see them together.
            return `Error: ${result.failures.map(f => describeFailure(f, String(path), edits.length)).join(' ')}`;
          }

          await atomicWrite(resolved, result.content);
          // Deliberately no hash precondition here: edit_file re-reads and
          // matches unique strings, so two edits to different parts of one
          // file both apply and both are correct. Recording the new hash keeps
          // a later write_file honest about what it would be overwriting —
          // but `markSeen: false`, because matching a substring is not reading
          // the file, and an edit must not promote a ranged read to `'complete'`.
          readFiles.set(resolved, await fileHash(resolved, { markSeen: false }));
          const where = relative(workspaceRoot, resolved);
          const changes = result.applied > 1 ? ` (${result.applied} changes)` : '';
          // Said only when the whitespace-tolerant fallback actually fired.
          // An edit that matched loosely still landed where it was meant to —
          // the offset map guarantees that — but the oldString the caller
          // believed it was matching is not the text in the file, so its idea
          // of that region has quietly drifted. Silence here is what lets the
          // next edit built on the same stale assumption fail for reasons that
          // look unrelated. Nothing is added to the common exact-match path.
          const loose = result.fuzzy > 0
            ? ` — ${result.fuzzy} matched loosely (whitespace or quote characters differed); re-read the file if you plan further edits here`
            : '';
          return `Successfully edited ${where}${changes}${loose}`;
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

  /**
   * What a reviewer is shown for a batch of edits.
   *
   * One diff of the file as it would end up, not a run of per-replacement
   * before/after blocks: with several edits in a call those blocks are read in
   * isolation, and whether they combine into something sensible is exactly what
   * a reviewer needs to see. Falls back to listing the requested replacements
   * when the edits cannot be located — the tool body will report why, and a
   * blank panel would say less than the attempt does.
   */
  const describeEdit = (input: Record<string, unknown>) => {
    const path = String(input.path);
    const edits = toEdits(input);
    const fallback = {
      toolName: 'edit_file',
      description: `Edit file: ${path}`,
      detail: edits ? simpleDiff(path, edits) : `Edit file: ${path}`,
    };
    if (!edits) return fallback;

    let resolved: string;
    try {
      resolved = resolveInWorkspace(workspaceRoot, path);
    } catch {
      return fallback;
    }
    let current: string;
    try { current = readFileSync(resolved, 'utf8'); } catch { return fallback; }

    const result = applyEdits(current, edits);
    if (!result.ok) return fallback;
    const { text, stats } = formatFileDiff(path, current, result.content);
    const count = result.applied > 1 ? `${result.applied} edits, ` : '';
    return {
      toolName: 'edit_file',
      description: `Edit file: ${path}  (${count}${describeDiff(stats)})`,
      detail: text,
    };
  };

  const edit_file = withApproval(
    edit_file_spec,
    approval,
    describeEdit,
    config.signal,
    config.caller,
    config.taskContext,
  );

  return { read_file, write_file, edit_file };
}
