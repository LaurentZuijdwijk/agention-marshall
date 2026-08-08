import { Tool } from '@agentionai/agents/core';
import type { ToolInputSchema } from '@agentionai/agents/core';
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveInWorkspace } from '../primitives/resolve.js';
import { cappedRead, DEFAULT_MAX_FILE_BYTES } from '../primitives/capped-read.js';
import { atomicWrite } from '../primitives/atomic-write.js';
import { createKeyedLock } from '../primitives/keyed-lock.js';
import { withApproval } from './approval.js';
import type { ToolConfig, ToolSpec, DedupeCache } from '../types.js';

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.next', 'dist', 'build', 'coverage',
  '.cache', '.turbo', '.svelte-kit', '__pycache__', '.venv',
]);

const MAX_SEARCH_RESULTS = 200;
const MAX_SEARCH_FILE_BYTES = 256 * 1024;

async function* walkFiles(dir: string): AsyncGenerator<string> {
  const info = await stat(dir);
  if (info.isFile()) {
    yield dir;
    return;
  }

  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

function simpleDiff(filePath: string, oldStr: string, newStr: string): string {
  const out = [`--- ${filePath}`, `+++ ${filePath}`];
  for (const l of oldStr.split('\n')) out.push(`- ${l}`);
  for (const l of newStr.split('\n')) out.push(`+ ${l}`);
  return out.join('\n');
}

function numberedLines(content: string, startLine: number, endLine: number): string {
  const lines = content.split('\n');
  const end = Math.min(endLine, lines.length);
  const width = String(end).length;
  return lines
    .slice(startLine - 1, end)
    .map((line, i) => `${String(startLine + i).padStart(width)} | ${line}`)
    .join('\n');
}

function safe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

// ── builders ──────────────────────────────────────────────────────────────────

function buildReadFile(
  workspaceRoot: string,
  maxFileBytes: number,
  readFiles: Map<string, string>,
  dedupeCache?: DedupeCache,
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
        const resolved = resolveInWorkspace(workspaceRoot, String(path));
        const content = await cappedRead(resolved, maxFileBytes);
        // The hash, not just the fact of the read: write_file compares against
        // it to catch an overwrite built from content that is no longer current.
        readFiles.set(resolved, hashContent(content));

        const totalLines = content.split('\n').length;
        const isFullRead = !startLine && !endLine;

        // Dedupe: on full reads, return a lightweight marker if content unchanged.
        if (isFullRead && dedupeCache) {
          const hash = hashContent(content);
          const cached = dedupeCache.get(resolved);
          if (cached && cached.hash === hash) {
            return (
              `# ${relative(workspaceRoot, resolved)}\n` +
              `[Unchanged since last read — ${totalLines} lines. ` +
              `Use startLine/endLine if you need a specific section.]`
            );
          }
          dedupeCache.set(resolved, { hash, lineCount: totalLines });
        }

        const start = startLine ? Math.max(1, Number(startLine)) : 1;
        const end = endLine ? Math.min(totalLines, Number(endLine)) : totalLines;
        const header = `# ${relative(workspaceRoot, resolved)}  (lines ${start}–${end} of ${totalLines})`;
        return header + '\n' + numberedLines(content, start, end);
      } catch (err) {
        return `Error: ${safe(err)}`;
      }
    },
  });
}

function buildListDir(workspaceRoot: string): Tool<string> {
  return new Tool<string>({
    name: 'list_dir',
    description:
      'List the files and directories inside a workspace directory. ' +
      'Each entry is prefixed with "f" (file) or "d" (directory).',
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
        return entries
          .map(e => `${e.isDirectory() ? 'd' : 'f'}  ${relative(workspaceRoot, join(resolved, e.name))}`)
          .join('\n');
      } catch (err) {
        return `Error: ${safe(err)}`;
      }
    },
  });
}

function buildSearch(workspaceRoot: string, maxSearchResults: number): Tool<string> {
  return new Tool<string>({
    name: 'search',
    description:
      'Search for a regex pattern across files in the workspace. ' +
      'Returns matches as "file:line: content".',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regex pattern to search for' },
        path: {
          type: 'string',
          description: 'Directory or file to search within. Defaults to workspace root.',
        },
        fileGlob: {
          type: 'string',
          description: 'Only search files whose name contains this string (e.g. ".ts")',
        },
      },
      required: ['pattern'],
    } satisfies ToolInputSchema,
    execute: async ({ pattern, path = '.', fileGlob }) => {
      try {
        const resolved = resolveInWorkspace(workspaceRoot, String(path));
        let regex: RegExp;
        try {
          regex = new RegExp(String(pattern), 'g');
        } catch (err) {
          return `Error: Invalid regex: ${safe(err)}`;
        }
        const glob = fileGlob ? String(fileGlob) : null;
        const results: string[] = [];
        let truncated = false;

        for await (const filePath of walkFiles(resolved)) {
          if (glob && !basename(filePath).includes(glob)) continue;
          let content: string;
          try { content = await cappedRead(filePath, MAX_SEARCH_FILE_BYTES); } catch { continue; }
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            regex.lastIndex = 0;
            if (regex.test(lines[i])) {
              results.push(`${relative(workspaceRoot, filePath)}:${i + 1}: ${lines[i].trim()}`);
              if (results.length > maxSearchResults) {
                truncated = true;
                break;
              }
            }
          }
          if (truncated) break;
        }

        if (results.length === 0) return 'No matches found.';
        if (truncated) results.length = maxSearchResults;
        return results.join('\n') + (truncated ? `\n[...truncated at ${maxSearchResults} matches...]` : '');
      } catch (err) {
        return `Error: ${safe(err)}`;
      }
    },
  });
}

// ── public factories ──────────────────────────────────────────────────────────

/** Read-only file tools for use in context sub-agents. */
export function createReadOnlyFileTools(
  workspaceRoot: string,
  limits: ToolConfig['limits'] = {},
  dedupeCache?: DedupeCache,
): Tool<string>[] {
  const maxFileBytes = limits?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxSearchResults = limits?.maxSearchResults ?? MAX_SEARCH_RESULTS;
  return [
    buildReadFile(workspaceRoot, maxFileBytes, new Map(), dedupeCache),
    buildListDir(workspaceRoot),
    buildSearch(workspaceRoot, maxSearchResults),
  ];
}

export function createFileTools(config: ToolConfig, dedupeCache?: DedupeCache): Tool<string>[] {
  const { workspaceRoot, approval, limits = {} } = config;
  const maxFileBytes = limits.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxSearchResults = limits.maxSearchResults ?? MAX_SEARCH_RESULTS;

  // Shared set: read_file populates it; write_file/edit_file check it. Supplied
  // by the session when it should outlive this belt — see ToolConfig.readFiles.
  const readFiles = config.readFiles ?? new Map<string, string>();

  /** The file as read_file would see it, hashed — same read path, so a large
   *  file's truncation does not make the two incomparable. */
  const fileHash = async (resolved: string): Promise<string> =>
    hashContent(await cappedRead(resolved, maxFileBytes));

  // Serialises the mutating tools per path. The model batches tool calls, and
  // both write_file and edit_file read the file before writing it back, so
  // without this two calls on one path race and the loser's edit vanishes.
  const withFileLock = createKeyedLock();

  const read_file = buildReadFile(workspaceRoot, maxFileBytes, readFiles, dedupeCache);
  const list_dir = buildListDir(workspaceRoot);
  const search = buildSearch(workspaceRoot, maxSearchResults);

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
            const actual = await fileHash(resolved);
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
          readFiles.set(resolved, await fileHash(resolved));
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
            `Call read_file first.`
          );
        }
        return await withFileLock(resolved, async () => {
          const original = await readFile(resolved, 'utf8');
          const old = String(oldString);
          const count = original.split(old).length - 1;
          if (count === 0) return `Error: oldString not found in ${path}.`;
          if (count > 1) return `Error: oldString appears ${count} times in ${path}. Be more specific.`;

          await atomicWrite(resolved, original.replace(old, String(newString)));
          // Deliberately no hash precondition here: edit_file re-reads and
          // matches a unique string, so two edits to different parts of one
          // file both apply and both are correct. Recording the new hash keeps
          // a later write_file honest about what it would be overwriting.
          readFiles.set(resolved, await fileHash(resolved));
          return `Edited ${relative(workspaceRoot, resolved)}`;
        });
      } catch (err) {
        return `Error: ${safe(err)}`;
      }
    },
  };

  const write_file = withApproval(
    write_file_spec,
    approval,
    ({ path, content }) => ({
      toolName: 'write_file',
      description: `Write file: ${path}`,
      detail: `Path: ${path}\n\n${String(content).slice(0, 800)}${String(content).length > 800 ? '\n[...]' : ''}`,
    }),
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

  return [read_file, list_dir, search, write_file, edit_file];
}
