import React from 'react';
import { Box, Text } from 'ink';
import { formatTokens as groupDigits, formatRate } from '@agentionai/marshall-engine';
import { formatDuration } from '../format.js';
import { C, G } from './theme.js';
import { Spinner } from './Spinner.js';

/**
 * `1.5k`, `10k`, `1.5M` — this row is a live, four-segment-wide status line,
 * not the `/tokens` report, so once a count is long enough to need grouped
 * digits it is better off abbreviated instead. An absent count is a dash, not
 * a zero — see the note on ActivityMetrics.
 */
const formatTokens = (n?: number): string => {
  if (n === undefined) return '—';
  if (n < 10_000) return groupDigits(n);
  const [divisor, suffix] = n >= 1_000_000 ? [1_000_000, 'M'] as const : [1_000, 'k'] as const;
  return `${(n / divisor).toFixed(1).replace(/\.0$/, '')}${suffix}`;
};

export type ActivityState = 'idle' | 'loading' | 'thinking' | 'generating' | 'complete' | 'error' | 'cancelled';

export interface ActivityMetrics {
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  /** Pre-formatted, because whether a cost is even knowable is the engine's call. */
  cost?: string;
  /**
   * Tokens per second, already measured and vetted by the engine.
   *
   * Rendered next to the count each belongs to rather than as its own segment,
   * because that is the only place the pairing is unambiguous: the rates are the
   * watched agent's alone, while the counts beside them include sub-agents.
   *
   * `input` goes missing on a model that thinks without streaming it, where the
   * wait before the first token is mostly generation and dividing the prompt by
   * it means nothing. `ttftMs` reports that wait instead — true either way.
   */
  rates?: { input?: number; output?: number };
  /** Time to the turn's first token. */
  ttftMs?: number;
  /**
   * The share of `outputTokens` spent thinking.
   *
   * Shown because without it the row does not add up: the output rate is the
   * rate the *streamed* tokens arrived at, so "2,100 at 2.5k/s" reads as a turn
   * that took under a second when it took four. Naming the 2,000 it thought
   * through resolves that, and is the more interesting number anyway.
   */
  reasoningTokens?: number;
}

/**
 * The turn's spend, sub-agents included.
 *
 * Tokens are the provider's own numbers, sampled as the turn runs — so the row
 * fills in mid-turn rather than staying blank until the answer lands. Only the
 * rate is ours: output tokens over wall-clock, which counts the time spent in
 * tool calls and approvals as generation time. It reads low on a turn that sat
 * waiting for a human, and that is the honest reading of "how fast is this
 * going", which is the question the row answers.
 */
export function ActivityStatus({
  state, metrics, pending = 0, blocked = false, canSkipReasoning = false,
  columns = process.stdout.columns ?? 80,
}: {
  state: ActivityState;
  metrics?: ActivityMetrics;
  pending?: number;
  /**
   * The turn is open but waiting on the user — an approval, a question. The
   * agent is not working, so the spinner stops: see Spinner's `animate`.
   */
  blocked?: boolean;
  /**
   * Only llama.cpp coder agents support ending their reasoning phase early
   * (see `Session.skipReasoning`) — the hint would be meaningless noise on
   * every other provider, so it only shows here, not baked into `Spinner`.
   */
  canSkipReasoning?: boolean;
  /** Terminal width, so the row sheds fields rather than lets the terminal
   *  hard-wrap it mid-word (Spinner's own "generating" label included). */
  columns?: number;
}) {
  if (state === 'idle' && pending === 0) return null;
  const label = state[0].toUpperCase() + state.slice(1);
  const active = state === 'thinking' || state === 'generating' || state === 'loading';
  // What the leading segment actually costs: the plain label when idle-ish,
  // or the Spinner's frame + verb + its own live elapsed counter when active
  // — accounted for here since it eats into the same row's budget below, even
  // though Spinner renders it independently.
  const leadingWidth = active
    ? 2 /* frame + space */ + (blocked ? 'waiting for you' : state === 'loading' ? 'loading' : state).length
      + 2 /* spaces before elapsed */ + 7 /* generous allowance for e.g. "23h59m" */
    : label.length;
  const withRate = (arrow: string, tokens?: number, perSecond?: number, showRate = true) => {
    const rate = showRate ? formatRate(perSecond) : undefined;
    return `${arrow}${formatTokens(tokens)}${rate ? ` ~${rate}` : ''}`;
  };
  const thinking = metrics?.reasoningTokens
    ? ` (${formatTokens(metrics.reasoningTokens)} thinking)`
    : '';
  let metric: string;
  if (metrics && (metrics.inputTokens !== undefined || metrics.outputTokens !== undefined)) {
    const counts = (showRates: boolean) =>
      withRate('↑', metrics.inputTokens, metrics.rates?.input, showRates)
        + `  ↓${formatTokens(metrics.outputTokens)}${thinking}`
        + (showRates && formatRate(metrics.rates?.output) ? ` ~${formatRate(metrics.rates?.output)}` : '');
    const duration = metrics.durationMs !== undefined ? formatDuration(metrics.durationMs) : undefined;
    const ttft = metrics.ttftMs !== undefined ? `${formatDuration(metrics.ttftMs)}→1st` : undefined;
    const cost = metrics.cost;

    // The full row can outrun a narrow terminal's width; the terminal then
    // hard-wraps it mid-character rather than reflowing cleanly (this is what
    // turns "generating" into "generatin" on redraw). So fields are dropped,
    // least essential first — ttft, then cost, then duration, then the ~/s
    // rates — until what's left actually fits. Token counts are the one
    // thing kept no matter how narrow the terminal gets.
    const budget = Math.max(columns - 4 /* Box paddingX */ - leadingWidth - 4 /* leading bullet */, 12);
    const build = (showTtft: boolean, showCost: boolean, showDuration: boolean, showRates: boolean) =>
      [counts(showRates), showDuration ? duration : undefined, showTtft ? ttft : undefined, showCost ? cost : undefined]
        .filter(Boolean).join(`  ${G.bullet}  `);

    let [showTtft, showCost, showDuration, showRates] = [true, true, true, true];
    let result = build(showTtft, showCost, showDuration, showRates);
    if (result.length > budget) { showTtft = false; result = build(showTtft, showCost, showDuration, showRates); }
    if (result.length > budget) { showCost = false; result = build(showTtft, showCost, showDuration, showRates); }
    if (result.length > budget) { showDuration = false; result = build(showTtft, showCost, showDuration, showRates); }
    if (result.length > budget) { showRates = false; result = build(showTtft, showCost, showDuration, showRates); }
    metric = result;
  } else {
    // Before the first response of a turn there is genuinely nothing to report,
    // and the engine says so by not sending anything rather than by sending
    // zeroes. Naming what is missing beats a row of placeholder dashes.
    metric = 'no tokens yet';
  }
  return (
    <Box paddingX={2} marginTop={1}>
      {active ? (
        <Spinner
          label={blocked ? 'waiting for you' : state === 'loading' ? 'loading' : state}
          animate={!blocked}
          inline
        />
      ) : (
        <Text color={state === 'error' ? C.error : state === 'cancelled' ? C.warn : C.muted}>
          {label}
        </Text>
      )}
      {state !== 'idle' && <Text color={C.faint}>  {G.bullet}  {metric}</Text>}
      {state === 'thinking' && canSkipReasoning && (
        <Text color={C.faint}>  {G.bullet}  ctrl-e to skip thinking</Text>
      )}
      {pending > 0 && <Text color={C.warn}>  {G.bullet}  {pending} prompt{pending === 1 ? '' : 's'} queued</Text>}
    </Box>
  );
}
