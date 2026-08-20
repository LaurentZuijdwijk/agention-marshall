import { Tool } from '@agentionai/agents/core';
import type { ToolInputSchema } from '@agentionai/agents/core';
import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { resolveInWorkspace } from '../../primitives/resolve.js';
import { safe } from '../../primitives/tool-error.js';

export function buildListDir(workspaceRoot: string): Tool<string> {
  return new Tool<string>({
    name: 'list_dir',
    description:
      'List files and directories, prefixed "f"/"d"; files also show size in bytes — prefer ' +
      'search over read_file for a large file when only part of it is needed.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path relative to workspace root. Defaults to workspace root.',
        },
      },
      required: [],
    } satisfies ToolInputSchema,
    execute: async ({ path = '.' }) => {
      try {
        const resolved = resolveInWorkspace(workspaceRoot, String(path));
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
    },
  });
}
