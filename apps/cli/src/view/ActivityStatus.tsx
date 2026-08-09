import React from 'react';
import { Box, Text } from 'ink';
import { C, G } from './theme.js';
import { Spinner } from './Spinner.js';

export type ActivityState = 'idle' | 'loading' | 'thinking' | 'generating' | 'complete' | 'error' | 'cancelled';

export interface ActivityMetrics {
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
}

/** Compact telemetry row; missing telemetry is stated rather than guessed. */
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
  const tokensPerSecond = metrics?.outputTokens !== undefined && metrics.durationMs !== undefined && metrics.durationMs > 0
    ? (metrics.outputTokens / (metrics.durationMs / 1000)).toFixed(1)
    : undefined;
  const metric = metrics && (metrics.inputTokens !== undefined || metrics.outputTokens !== undefined)
    ? `↑${metrics.inputTokens ?? '—'}  ↓${metrics.outputTokens ?? '—'}  ${G.bullet}  ${metrics.durationMs !== undefined ? `${(metrics.durationMs / 1000).toFixed(1)}s` : 'duration unavailable'}  ${G.bullet}  ${tokensPerSecond !== undefined ? `~${tokensPerSecond} tok/s` : 'tok/s unavailable'}`
    : 'metrics unavailable';
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
