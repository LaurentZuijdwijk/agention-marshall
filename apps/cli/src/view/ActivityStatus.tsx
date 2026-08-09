import React from 'react';
import { Box, Text } from 'ink';
import { formatTokens as groupDigits, formatRate } from '@agentionai/marshall-engine';
import { C, G } from './theme.js';
import { Spinner } from './Spinner.js';

/** An absent count is a dash, not a zero — see the note on ActivityMetrics. */
const formatTokens = (n?: number) => (n === undefined ? '—' : groupDigits(n));

export type ActivityState = 'idle' | 'loading' | 'thinking' | 'generating' | 'complete' | 'error' | 'cancelled';

export interface ActivityMetrics {
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  /** Pre-formatted, because whether a cost is even knowable is the engine's call. */
  cost?: string;
  /**
   * Output tokens per second of model time, already measured by the engine.
   *
   * Rendered next to the count it belongs to rather than as its own segment,
   * because that is the only place the pairing is unambiguous: the rate is the
   * watched agent's alone, while the counts beside it include sub-agents.
   *
   * There is no matching figure for input. The wait before the first token is
   * prompt processing on one model and silent thinking on the next, and nothing
   * we can see tells the two apart — so `ttftMs` reports the wait itself rather
   * than dividing tokens by it. See TurnPhases.
   */
  rates?: { output?: number };
  /** Time to the turn's first token. */
  ttftMs?: number;
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
export function ActivityStatus({ state, metrics, pending = 0, blocked = false }: {
  state: ActivityState;
  metrics?: ActivityMetrics;
  pending?: number;
  /**
   * The turn is open but waiting on the user — an approval, a question. The
   * agent is not working, so the spinner stops: see Spinner's `animate`.
   */
  blocked?: boolean;
}) {
  if (state === 'idle' && pending === 0) return null;
  const label = state[0].toUpperCase() + state.slice(1);
  const outputRate = formatRate(metrics?.rates?.output);
  const metric = metrics && (metrics.inputTokens !== undefined || metrics.outputTokens !== undefined)
    ? [
        `↑${formatTokens(metrics.inputTokens)}`
          + `  ↓${formatTokens(metrics.outputTokens)}${outputRate ? ` ~${outputRate}` : ''}`,
        metrics.durationMs !== undefined ? `${(metrics.durationMs / 1000).toFixed(1)}s` : undefined,
        // Abbreviated because the row is already four segments wide, and this is
        // the one a reader glances at rather than reads.
        metrics.ttftMs !== undefined ? `${(metrics.ttftMs / 1000).toFixed(1)}s→1st` : undefined,
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
      {pending > 0 && <Text color={C.warn}>  {G.bullet}  {pending} prompt{pending === 1 ? '' : 's'} queued</Text>}
    </Box>
  );
}
