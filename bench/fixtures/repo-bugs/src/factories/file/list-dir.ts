import { Tool } from '@agentionai/agents/core';
import type { ToolInputSchema } from '@agentionai/agents/core';
import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { resolveInWorkspace } from '../../primitives/resolve.js';
import { safe } from '../../primitives/tool-error.js';

/**
 * The requested directories, however the caller expressed them.
 *
 * `paths[]` is the shape worth using — one call for every directory the
 * caller wants listed, the same reason `edit_file` has `edits[]` — but the
 * single `path` string is still accepted and folded into a one-element
 * batch, and no arguments at all still means "list the workspace root," the
 * same default `list_dir` has always had.
 *
 * `paths` arrives as a JSON *string* from some models rather than as an
 * array, so that is parsed rather than rejected, the same defence
 * `edit_file` applies to `edits`.
 */
function toPaths(input: Record<string, unknown>): string[] {
  const raw = input.paths;
  let list: unknown;
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw); } catch { list = undefined; }
  } else {
    list = raw;
  }

  if (Array.isArray(list) && list.length > 0) return list.map(String);
  if (input.path !== undefined) return [String(input.path)];
  return ['.'];
}

/**
 * Entries rendered for one directory, and for one whole call.
 *
 * `list_dir` had no cap of any kind: a `node_modules` or a dataset directory
 * returned a line per entry, however many that was. Batching turned that from a
 * sharp edge into a multiplied one, so the bound arrives with the batch. The
 * per-call ceiling is the one that matters — it is the model's context being
 * spent — and the per-directory one keeps a single huge directory from
 * consuming all of it before the others are reached.
 */
const MAX_ENTRIES_PER_DIR = 500;
const MAX_ENTRIES_PER_CALL = 1000;

async function listOneDir(workspaceRoot: string, path: string, budget = MAX_ENTRIES_PER_DIR): Promise<string> {
  try {
    const resolved = resolveInWorkspace(workspaceRoot, path);
    const all = await readdir(resolved, { withFileTypes: true });
    if (all.length === 0) return '(empty directory)';
    const cap = Math.min(budget, MAX_ENTRIES_PER_DIR);
    const entries = all.slice(0, cap);
    const omitted = all.length - entries.length;

    // Stat every entry in parallel rather than one directory-wide call:
    // a directory listing is exactly the surface a symlink race is easy
    // to hit on, and one entry's disappearance between readdir and stat
    // should not fail the whole listing.
    const rows = await Promise.all(entries.map(async (e) => {
      const rel = relative(workspaceRoot, join(resolved, e.name));
      if (e.isDirectory()) return { kind: 'd', size: null, rel };
      const size = await stat(join(resolved, e.name)).then(s => s.size, () => null);
      return { kind: 'f', size, rel };
    }));

    // `reduce`, not `Math.max(0, ...rows.map(…))`: the spread passes one
    // argument per entry, and a directory with enough of them overflows the
    // argument list and throws instead of listing.
    const width = rows.reduce((w, r) => Math.max(w, r.size === null ? 0 : String(r.size).length), 0);
    const listing = rows
      .map(r => `${r.kind}  ${r.size === null ? ' '.repeat(width) : String(r.size).padStart(width)}  ${r.rel}`)
      .join('\n');
    // Said, not silent: a truncated listing that looks complete is how a caller
    // concludes a file is absent when it simply came after the cap.
    return omitted > 0
      ? `${listing}\n[${omitted} more entr${omitted === 1 ? 'y' : 'ies'} not shown — narrow with a subdirectory, or use search]`
      : listing;
  } catch (err) {
    return `Error: ${safe(err)}`;
  }
}

/** Rows a rendered listing actually spent, so a batch can bound its total. */
function countEntries(block: string): number {
  return block.split('\n').filter(l => /^[fd] /.test(l)).length;
}

export function buildListDir(workspaceRoot: string): Tool<string> {
  return new Tool<string>({
    name: 'list_dir',
    description:
      'List files and directories, prefixed "f"/"d"; files also show size in bytes — prefer ' +
      'search over read_file for a large file when only part of it is needed. Put every directory ' +
      'you need listed in paths[] rather than calling this repeatedly.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Directory paths relative to workspace root, one call for all of them. Defaults to the workspace root.',
        },
      },
      required: [],
    } satisfies ToolInputSchema,
    execute: async (input) => {
      const paths = toPaths(input);
      if (paths.length === 1) return listOneDir(workspaceRoot, paths[0]);

      // Sequential for the same reason `search` is: a listing already stats
      // every entry in parallel within one directory, and fanning the
      // directories out on top of that multiplies open handles by the batch
      // size for no gain the caller can see. The shared budget is why the
      // ordering matters — spending it first-come keeps one enormous directory
      // from consuming the whole call silently.
      let spent = 0;
      const blocks: string[] = [];
      for (const [i, p] of paths.entries()) {
        if (spent >= MAX_ENTRIES_PER_CALL) {
          const skipped = paths.length - i;
          blocks.push(`[entry budget of ${MAX_ENTRIES_PER_CALL} reached — ${skipped} further `
            + `director${skipped === 1 ? 'y' : 'ies'} not listed]`);
          break;
        }
        const block = await listOneDir(workspaceRoot, p, MAX_ENTRIES_PER_CALL - spent);
        spent += countEntries(block);
        blocks.push(`${p}:\n${block}`);
      }
      return blocks.join('\n\n');
    },
  });
}
