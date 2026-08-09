// ── history tracing (opt-in debug aid) ────────────────────────────────────────
//
// `MARSHALL_TRACE_HISTORY=1` writes the conversation, as the model receives it,
// to `.marshall/logs/history.log` around every turn. `=full` skips truncation.
//
// The session log records what you typed and which tools ran. It has never
// recorded what was actually *sent*, which is why "the agent forgot the previous
// answer" is unanswerable from it: the entry could be missing from history, or
// present but masked before it left the process, or present in full and ignored
// by the model — three very different bugs, and only the first two are ours.
//
// `getEntries()` rather than `entries` is the whole point. Transform plugins run
// at read time, so the raw store and the document that leaves the process are
// not the same thing; tool-result masking rewrites exactly the kind of content
// (a long file read, a story printed by a shell command) whose disappearance
// reads as amnesia. Both are serialised, and anything the transform changed is
// marked, so masking is visible rather than inferred.

import type { History, HistoryEntry, MessageContent } from '@agentionai/agents/core';

/** Long enough to recognise a file or an answer, short enough to keep the log readable. */
const DEFAULT_MAX_CHARS = 2_000;

/**
 * The system prompt is identical in every record and a dozen lines long, so at
 * full width it buries the two or three entries anyone is actually reading the
 * file for. `full` mode still prints it whole — light mode and the safety levels
 * change it, and then it is the thing you came to check.
 */
const SYSTEM_MAX_CHARS = 120;

export type TraceMode = 'off' | 'truncated' | 'full';

/** How `MARSHALL_TRACE_HISTORY` reads. Exported so the parsing is testable. */
export function traceMode(value: string | undefined): TraceMode {
  if (value === undefined || value === '' || value === '0' || value === 'false') return 'off';
  return value === 'full' ? 'full' : 'truncated';
}

function clip(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}… +${text.length - maxChars} more chars`;
}

/** Continuation lines line up under the first, so one entry reads as one block. */
function indent(text: string, width: number): string {
  return text.split('\n').join('\n' + ' '.repeat(width));
}

const LABEL_WIDTH = 24;

function describe(content: MessageContent): { label: string; body: string } {
  switch (content.type) {
    case 'text':
      return { label: 'text', body: content.text };
    case 'tool_use':
      return { label: `tool_use ${content.name}`, body: `${content.id} ${JSON.stringify(content.input)}` };
    case 'tool_result':
      return {
        label: `tool_result${content.is_error ? ' (error)' : ''}`,
        body: `${content.tool_use_id} ${content.content}`,
      };
    case 'thinking':
      return { label: 'thinking', body: content.thinking };
    case 'image_url':
      return { label: 'image_url', body: content.url };
    case 'image_base64':
      return { label: 'image_base64', body: `${content.mimeType}, ${content.data.length} base64 chars` };
  }
}

/** Every tool result in the raw store, by id — the yardstick for "was this masked?". */
function rawToolResults(entries: HistoryEntry[]): Map<string, string> {
  const byId = new Map<string, string>();
  for (const entry of entries) {
    for (const content of entry.content) {
      if (content.type === 'tool_result') byId.set(content.tool_use_id, content.content);
    }
  }
  return byId;
}

export interface SerialiseOptions {
  /** 0 means no truncation. */
  maxChars?: number;
  /** Raw entries, for marking what a transform plugin rewrote on the way out. */
  raw?: HistoryEntry[];
}

/**
 * The conversation as one readable block.
 *
 * Pure, and exported separately from the writer below, so the format can be
 * tested without a Session, a filesystem or an environment variable.
 */
export function serialiseHistory(entries: HistoryEntry[], options: SerialiseOptions = {}): string {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const raw = options.raw ? rawToolResults(options.raw) : undefined;
  const lines: string[] = [];

  for (const [i, entry] of entries.entries()) {
    for (const content of entry.content) {
      const { label, body } = describe(content);
      // A tool result whose stored content differs from what is being sent was
      // rewritten on the way out — that is the masking plugin, and it is the
      // single most likely reason for content the model "should" have.
      const masked = raw !== undefined
        && content.type === 'tool_result'
        && raw.get(content.tool_use_id) !== content.content;
      const budget = entry.role === 'system' && maxChars > 0 ? SYSTEM_MAX_CHARS : maxChars;
      const head = `${String(i).padStart(3)} ${entry.role} ${label}${masked ? ' [masked]' : ''}`;
      lines.push(`${head.padEnd(LABEL_WIDTH)} ${indent(clip(body, budget), LABEL_WIDTH + 1)}`);
    }
  }

  return lines.join('\n');
}

/**
 * One trace record: a header naming the moment, then the conversation.
 *
 * Both entry counts are in the header because a difference between them is the
 * fastest signal that something is being dropped rather than merely truncated.
 */
export function formatTrace(history: History, label: string, mode: TraceMode): string {
  const sent = history.getEntries();
  const raw = history.entries;
  const header =
    `[${new Date().toISOString()}] ${label} — ${sent.length} entries sent`
    + (raw.length === sent.length ? '' : ` (${raw.length} stored)`)
    + `, ~${history.totalEstimatedTokens} tokens`;
  const body = serialiseHistory(sent, { maxChars: mode === 'full' ? 0 : DEFAULT_MAX_CHARS, raw });
  return `${header}\n${body}\n\n`;
}
