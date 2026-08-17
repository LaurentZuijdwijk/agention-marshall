import React from 'react';
import { Box, Text } from 'ink';
import { formatTokens as groupDigits, formatRate } from '@agentionai/marshall-engine';
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

/**
 * `12.3s`, `24m59s`, `1h05m` — a turn or a first-token wait can run long
 * enough that a raw seconds count stops being readable at a glance. Whole
 * seconds only past a minute: the tenths that matter for "how long did the
 * first token take" stop being interesting once the answer is in minutes.
 */
const formatDuration = (ms: number): string => {
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const pad = (n: number) => String(n).padStart(2, '0');
  const roundedSeconds = Math.round(totalSeconds);
  const minutes = Math.floor(roundedSeconds / 60);
  const seconds = roundedSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m${pad(seconds)}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h${pad(remainingMinutes)}m`;
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
export function ActivityStatus({ state, metrics, pending = 0, blocked = false, canSkipReasoning = false }: {
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
}) {
  if (state === 'idle' && pending === 0) return null;
  const label = state[0].toUpperCase() + state.slice(1);
  const withRate = (arrow: string, tokens?: number, perSecond?: number) => {
    const rate = formatRate(perSecond);
    return `${arrow}${formatTokens(tokens)}${rate ? ` ~${rate}` : ''}`;
  };
  const thinking = metrics?.reasoningTokens
    ? ` (${formatTokens(metrics.reasoningTokens)} thinking)`
    : '';
  const metric = metrics && (metrics.inputTokens !== undefined || metrics.outputTokens !== undefined)
    ? [
        withRate('↑', metrics.inputTokens, metrics.rates?.input)
          + `  ↓${formatTokens(metrics.outputTokens)}${thinking}`
          + (formatRate(metrics.rates?.output) ? ` ~${formatRate(metrics.rates?.output)}` : ''),
        metrics.durationMs !== undefined ? formatDuration(metrics.durationMs) : undefined,
        // Abbreviated because the row is already four segments wide, and this is
        // the one a reader glances at rather than reads.
        metrics.ttftMs !== undefined ? `${formatDuration(metrics.ttftMs)}→1st` : undefined,
        metrics.cost,
      ].filter(Boolean).join(`  ${G.bullet}  `)
    // Before the first response of a turn there is genuinely nothing to report,
    // and the engine says so by not sending anything rather than by sending
    // zeroes. Naming what is missing beats a row of placeholder dashes.
    : 'no tokens yet';
  const active = state === 'thinking' || state === 'generating' || state === 'loading';
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
