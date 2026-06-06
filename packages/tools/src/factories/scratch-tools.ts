import { Tool } from '@agentionai/agents/core';
import type { ToolInputSchema } from '@agentionai/agents/core';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { atomicWrite } from '../primitives/atomic-write.js';
import { cappedRead, DEFAULT_MAX_FILE_BYTES } from '../primitives/capped-read.js';
import { resolveInWorkspace } from '../primitives/resolve.js';
import type { ToolConfig } from '../types.js';

/**
 * The scratch area lives at WORKSPACE_ROOT/.marshall/ and is the agent's
 * private space — no approval gate. It is intentionally excluded from
 * createFileTools (workspace files) so it has its own clear boundary.
 *
 * Layout:
 *   .marshall/notes/   — named markdown notes the agent creates/updates
 *   .marshall/session.log — append-only human-readable session journal
 */
function safe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createScratchTools(config: ToolConfig): Tool<string>[] {
  const { workspaceRoot, limits = {} } = config;
  const scratchRoot = join(workspaceRoot, '.marshall');
  const notesDir = join(scratchRoot, 'notes');
  const sessionLog = join(scratchRoot, 'session.log');
  const maxFileBytes = limits.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  async function ensureDirs() {
    await mkdir(notesDir, { recursive: true });
  }

  const note_write = new Tool<string>({
    name: 'note_write',
    description:
      'Write or update a named note in the agent\'s private scratch area (.marshall/notes/). ' +
      'Use this to record plans, observations, decisions, or context that should persist ' +
      'across tool calls. No user approval needed.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Note filename without extension (e.g. "plan", "findings")' },
        content: { type: 'string', description: 'Markdown content to write' },
      },
      required: ['name', 'content'],
    } satisfies ToolInputSchema,
    execute: async ({ name, content }) => {
      try {
        await ensureDirs();
        // Sanitise: strip path separators so the name stays inside notesDir
        const safeName = String(name).replace(/[/\\]/g, '_').replace(/\.\.+/g, '_');
        const filePath = join(notesDir, `${safeName}.md`);
        await atomicWrite(filePath, String(content));
        return `Note "${safeName}" saved to .marshall/notes/`;
      } catch (err) {
        return `Error: ${safe(err)}`;
      }
    },
  });

  const note_read = new Tool<string>({
    name: 'note_read',
    description: 'Read a note from the agent\'s private scratch area (.marshall/notes/).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Note name (without .md extension)' },
      },
      required: ['name'],
    } satisfies ToolInputSchema,
    execute: async ({ name }) => {
      try {
        // Use resolveInWorkspace so the name can't escape scratchRoot
        const safeName = String(name).replace(/[/\\]/g, '_').replace(/\.\.+/g, '_');
        const filePath = join(notesDir, `${safeName}.md`);
        if (!existsSync(filePath)) return `Note "${safeName}" not found. Use note_list to see available notes.`;
        return await cappedRead(filePath, maxFileBytes);
      } catch (err) {
        return `Error: ${safe(err)}`;
      }
    },
  });

  const note_list = new Tool<string>({
    name: 'note_list',
    description: 'List all notes in the agent\'s private scratch area.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    } satisfies ToolInputSchema,
    execute: async () => {
      try {
        await ensureDirs();
        const entries = await readdir(notesDir, { withFileTypes: true });
        const notes = entries.filter(e => e.isFile() && e.name.endsWith('.md'));
        if (notes.length === 0) return '(no notes yet)';
        return notes.map(e => basename(e.name, '.md')).join('\n');
      } catch (err) {
        return `Error: ${safe(err)}`;
      }
    },
  });

  const log_append = new Tool<string>({
    name: 'log_append',
    description:
      'Append a timestamped entry to the agent\'s session log (.marshall/session.log). ' +
      'Use this to record progress, decisions, and completed steps.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Log entry text (plain text or markdown)' },
      },
      required: ['message'],
    } satisfies ToolInputSchema,
    execute: async ({ message }) => {
      try {
        await ensureDirs();
        const timestamp = new Date().toISOString();
        const entry = `\n## ${timestamp}\n\n${String(message)}\n`;
        // Read-then-append to avoid full file rewrite on large logs
        const existing = existsSync(sessionLog)
          ? await readFile(sessionLog, 'utf8')
          : '';
        await atomicWrite(sessionLog, existing + entry);
        return `Logged at ${timestamp}`;
      } catch (err) {
        return `Error: ${safe(err)}`;
      }
    },
  });

  const log_read = new Tool<string>({
    name: 'log_read',
    description: 'Read the session log from the agent\'s private scratch area.',
    inputSchema: {
      type: 'object',
      properties: {
        tail: { type: 'number', description: 'Only return the last N lines. Omit for the full log.' },
      },
      required: [],
    } satisfies ToolInputSchema,
    execute: async ({ tail }) => {
      try {
        if (!existsSync(sessionLog)) return '(no session log yet)';
        const content = await cappedRead(sessionLog, maxFileBytes);
        if (!tail) return content;
        const lines = content.split('\n');
        return lines.slice(-Number(tail)).join('\n');
      } catch (err) {
        return `Error: ${safe(err)}`;
      }
    },
  });

  return [note_write, note_read, note_list, log_append, log_read];
}
