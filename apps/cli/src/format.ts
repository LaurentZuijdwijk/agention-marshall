// ── display formatting helpers (pure logic, testable) ─────────────────────────

import wrapAnsi from 'wrap-ansi';
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
 * Reflow reasoning for display: single newlines become spaces, blank lines stay
 * as paragraph breaks.
 *
 * Reasoning is the one text on screen whose line structure we do not control.
 * It is streamed as deltas and shown as whatever concatenating them produced,
 * so an endpoint that terminates each delta with a newline renders one token
 * per row — a column of single words down the left edge, many times taller
 * than the row budget, which then trips the whole-terminal repaint. Observed
 * against an OpenRouter stealth endpoint; a provider we have not tried yet can
 * break lines wherever it likes, and the view should not be at its mercy.
 *
 * The rule is the one markdown already uses, and the one `view/markdown.ts`
 * applies to its own blocks: a line break inside a paragraph is not meaningful,
 * a blank line is. Thinking written as a list therefore reflows into prose —
 * accepted, because it is ephemeral, already tail-truncated by
 * MAX_REASONING_PER_STEP, and unreadable in the failure case this prevents.
 *
 * Display only. The raw text still reaches history through `reasoningRef`.
 */
export function reflowProse(text: string): string {
  return text
    // Paragraph breaks first, so the joining below cannot eat them. Any run of
    // blank lines is one break; trailing spaces are what make a "blank" line
    // fail a naive \n\n test against real model output.
    .split(/\n[ \t]*\n(?:[ \t]*\n)*/)
    .map(joinLines)
    // A paragraph that reflows to nothing contributes nothing. Without this,
    // leading and trailing whitespace in the buffer — which a live stream has
    // constantly, mid-delta — becomes empty paragraphs, and those render as
    // blank rows off the top and bottom of the block.
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Join a paragraph's lines back into one, restoring a space only where the
 * break was standing in for one.
 *
 * Which it was is decided by what sits either side, because the two cases this
 * has to serve want opposite answers. A break between deltas is pure noise —
 * the delta carries its own leading space when it needs one, so `"smoke"` +
 * `"-test"` and `"expected"` + `"."` must be concatenated flat, and inserting
 * a space gives "smoke -test" and "expected .". A break a model wrote inside a
 * paragraph, though, is a word separator: `"runs"` + `"on two lines"` needs
 * one, or it fuses into "runson".
 *
 * A space is therefore added only when the join would otherwise weld two words
 * together — text on the left, a letter or digit on the right. Punctuation,
 * hyphens and anything already spaced are left to concatenate, which is what
 * both cases actually want.
 */
function joinLines(paragraph: string): string {
  let out = '';
  for (const line of paragraph.split('\n')) {
    if (line === '') continue;
    out += (/\S$/.test(out) && /^[\p{L}\p{N}]/u.test(line) ? ' ' : '') + line;
  }
  return out.trim();
}

/**
 * Wrap exactly the way Ink will, so a budget counted in rows here is the number
 * of rows the terminal actually draws.
 *
 * This has to be Ink's wrapper rather than an equivalent-looking one. The row
 * budget is only worth anything if it matches, and the two disagree in the
 * expensive direction: chopping every `width` characters packs more into a row
 * than word wrapping does, so a chop-counted budget *under*-counts — measured
 * at 140 columns, ten paragraphs of prose budgeted as 21 rows and drew 31. The
 * live region then overruns the viewport, and Ink answers an oversized frame by
 * clearing the terminal and reprinting the whole transcript on every token.
 *
 * Options match `ink/build/wrap-text.js` (`trim` is ours, see
 * patches/ink+7.1.1.patch). Costs ~0.4ms per call at a full live buffer, paid
 * per streamed token; the repaint storm it prevents costs far more than that.
 */
function wrapRows(text: string, width: number): string[] {
  return wrapAnsi(text, width, { trim: true, hard: true }).split('\n');
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
  // throwaway `rows` arrays per second to pressure the GC hard.
  //
  // `maxRows + 1` rows' worth of characters is always enough, in the one
  // direction that matters: word wrapping packs *less* into a row than a
  // straight chop, so this many characters can only ever wrap to *more* than
  // maxRows rows, never fewer. The extra row covers a cut landing mid-row so
  // the true last row still comes out whole. A few characters of misalignment
  // at the very top of a truncated live buffer is invisible — it's ephemeral
  // and scrolling; the untruncated text still lands in <Static> once the turn
  // completes.
  const tailBudget = (maxRows + 1) * width;
  const tail = text.length > tailBudget ? text.slice(-tailBudget) : text;

  const rows = wrapRows(tail, width);

  // Under budget: hand back the raw tail and let Ink wrap it. Safe precisely
  // because `rows` was counted with Ink's own wrap — it will draw `rows.length`
  // rows, which is the number just checked.
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
