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

async function listOneDir(workspaceRoot: string, path: string): Promise<string> {
  try {
    const resolved = resolveInWorkspace(workspaceRoot, path);
    const entries = await readdir(resolved, { withFileTypes: true });
    if (entries.length === 0) return '(empty directory)';

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
    return rows
      .map(r => `${r.kind}  ${r.size === null ? ' '.repeat(width) : String(r.size).padStart(width)}  ${r.rel}`)
      .join('\n');
  } catch (err) {
    return `Error: ${safe(err)}`;
  }
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
      // size for no gain the caller can see.
      const blocks: string[] = [];
      for (const p of paths) {
        blocks.push(`${p}:\n${await listOneDir(workspaceRoot, p)}`);
      }
      return blocks.join('\n\n');
    },
  });
}
