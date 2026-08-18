// ── display formatting helpers (pure logic, testable) ─────────────────────────

import { formatCost, formatTokens } from '@agentionai/marshall-engine';
import type { UsageReport } from '@agentionai/marshall-engine';

/**
 * Keys that carry the "what is this call actually doing" information. When a
 * tool input has one of these we show it verbatim instead of dumping JSON —
 * `read_file  src/App.tsx` reads far better than `read_file  {"path":"src/…`.
 */
const PRIMARY_KEYS = ['command', 'path', 'file_path', 'pattern', 'query', 'url', 'task', 'instructions'];

/** Turn a `snake_case` tool identifier into a readable label: `edit_file` → `Edit file`. */
export function formatToolName(name: string): string {
  const [first, ...rest] = name.split('_');
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(' ');
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + '…';
}

function scalar(value: unknown): string {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ');
  if (Array.isArray(value)) return `[${value.length}]`;
  if (value && typeof value === 'object') return '{…}';
  return String(value);
}

/** Render a tool's input as a single compact, human-readable line. */
export function formatToolInput(input: unknown, max = 96): string {
  if (input == null || typeof input !== 'object') return '';

  const obj = input as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return '';

  const primary = PRIMARY_KEYS.find(k => typeof obj[k] === 'string' && obj[k] !== '');
  const text = primary
    ? scalar(obj[primary]) + (keys.length > 1 ? `  +${keys.length - 1}` : '')
    : keys.map(k => `${k}=${scalar(obj[k])}`).join(' ');

  return truncate(text, max);
}

/**
 * Shorten a path for the header: collapse $HOME to `~`, then elide leading
 * segments if it is still too long, keeping the tail (which is what identifies
 * the project).
 */
export function shortenPath(path: string, home?: string, max = 64): string {
  let out = home && path.startsWith(home) ? '~' + path.slice(home.length) : path;
  if (out.length <= max) return out;

  const parts = out.split('/');
  while (parts.length > 2 && parts.join('/').length > max) parts.shift();
  return '…/' + parts.join('/');
}

/** Split a `provider/model` style label so each half can be coloured. */
export function splitModelLabel(provider: string, model?: string): [string, string] {
  return [provider, model ?? 'default'];
}

/**
 * Keep only the last `maxRows` wrapped rows of `text`.
 *
 * Ink redraws the non-static region by rewinding the cursor, but only while
 * that region fits the viewport. The moment it is taller, Ink falls back to
 * clearing the terminal and reprinting all static output plus the frame — on
 * *every* render. A streaming response re-renders per token, so once the live
 * text outgrows the terminal that fallback fires hundreds of times and each
 * reprint lands in scrollback, leaving the same paragraph stamped over and over.
 *
 * Clamping the live preview keeps the region under the viewport so Ink stays on
 * the incremental path. Nothing is lost: the full text is pushed into <Static>
 * once the response completes.
 */
export function clampToRows(text: string, columns: number, maxRows: number): string {
  if (maxRows <= 0 || columns <= 0) return '';

  const width = Math.max(1, columns);

  // Only the last maxRows rows can ever be shown, so bound how much of `text`
  // gets wrapped before that. Called on every appended chunk during a live
  // stream — reprocessing the full accumulated length each time is O(n²) over
  // the life of a turn, and on a long uncapped run allocates enough
  // throwaway `rows` arrays per second to pressure the GC hard. The +width
  // slack covers the case where the cut lands mid-row so the true last row
  // still comes out whole. A few characters of misalignment at the very top
  // of a truncated live buffer is invisible — it's ephemeral and scrolling;
  // the untruncated text still lands in <Static> once the turn completes.
  const tailBudget = (maxRows + 1) * width;
  const tail = text.length > tailBudget ? text.slice(-tailBudget) : text;

  const rows: string[] = [];
  for (const line of tail.split('\n')) {
    if (line === '') { rows.push(''); continue; }
    for (let i = 0; i < line.length; i += width) rows.push(line.slice(i, i + width));
  }

  return rows.length <= maxRows ? tail : rows.slice(rows.length - maxRows).join('\n');
}

/**
 * Which slice of a long list to show, keeping the cursor near the middle and
 * never scrolling past either end.
 */
export function windowRange(count: number, cursor: number, size: number): { start: number; end: number } {
  if (count <= size) return { start: 0, end: count };
  const half = Math.floor(size / 2);
  const start = Math.max(0, Math.min(cursor - half, count - size));
  return { start, end: start + size };
}

/**
 * The `/tokens` report: what the session spent, and which agent spent it.
 *
 * Per role *and* model rather than per role alone, because the interesting
 * question in a tiered setup is which tier the money went to — a `context` line
 * naming a local model and a `coder` line naming a hosted one answer it at a
 * glance, and rolling them together does not.
 */
export function formatUsageReport(report: UsageReport): string {
  const { session, byRole } = report;
  if (byRole.length === 0) return 'no tokens spent yet';

  const cost = formatCost(session);
  const lines = [
    `session  ↑${formatTokens(session.inputTokens)}  ↓${formatTokens(session.outputTokens)}`
    + (session.reasoningTokens ? ` (${formatTokens(session.reasoningTokens)} thinking)` : '')
    + (cost ? `  ${cost}` : ''),
  ];

  // Padded off the longest entry rather than a fixed width: model ids run from
  // `gpt-5.6-luna` to a 40-character vendor slug, and a fixed column either
  // wastes half the row or fails to align the case it was picked for.
  const roleWidth = Math.max(...byRole.map(entry => entry.role.length));
  const modelWidth = Math.max(...byRole.map(entry => entry.model.length));
  for (const entry of byRole) {
    const entryCost = formatCost(entry);
    lines.push(
      `  ${entry.role.padEnd(roleWidth)}  ${entry.model.padEnd(modelWidth)}` +
      `  ↑${formatTokens(entry.inputTokens)}  ↓${formatTokens(entry.outputTokens)}` +
      // Billed as output either way, so it sits inside the ↓ figure rather than
      // beside it. Worth naming because it is the one line item you can change
      // without changing what you asked for.
      (entry.reasoningTokens ? ` (${formatTokens(entry.reasoningTokens)} thinking)` : '') +
      (entryCost ? `  ${entryCost}` : ''),
    );
  }

  // Only when it would not merely repeat the header: a session with one agent
  // in it has already said this.
  if (session.costPartial) {
    lines.push('  (+ means part of this ran on a model with no published price)');
  }
  return lines.join('\n');
}
