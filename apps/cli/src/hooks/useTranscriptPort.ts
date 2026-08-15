import { useMemo, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { formatCost } from '@agentionai/marshall-engine';
import type { ActivityMetrics } from '../view/ActivityStatus.js';
import type { Mode } from '../mode.js';
import type { TranscriptPort } from './useEngineClient.js';
import type { Transcript } from './useTranscript.js';
import type { Approvals } from './useApprovals.js';
import type { Questions } from './useQuestions.js';
import type { PreferencesController } from './usePreferences.js';

export type Activity = 'idle' | 'loading' | 'thinking' | 'generating' | 'complete' | 'error' | 'cancelled';

export interface UseTranscriptPortOptions {
  transcript: Transcript;
  approvals: Approvals;
  questions: Questions;
  setSteering: (steering: boolean) => void;
  prefs: PreferencesController;
  setActivity: (activity: Activity) => void;
  setMetrics: (metrics: ActivityMetrics) => void;
  /** `Dispatch`, not the narrower `SetMode`, because `turnStarted` needs the
   *  functional-update form to promote only an `idle` mode to `running`. */
  setMode: Dispatch<SetStateAction<Mode>>;
}

/**
 * The `TranscriptPort` handed to `useEngineClient` — everything engine events
 * turn into on screen.
 *
 * The client is memoised once and fires at event time, so everything it reads
 * has to come through a ref rather than a closed-over render value; that ref
 * lives here rather than in `App` so the port and its one piece of mutable
 * state travel together.
 */
export function useTranscriptPort({
  transcript, approvals, questions, setSteering, prefs, setActivity, setMetrics, setMode,
}: UseTranscriptPortOptions): TranscriptPort {
  const live = useRef({ transcript, approvals, questions, setSteering, prefs });
  live.current = { transcript, approvals, questions, setSteering, prefs };

  // Preference gating lives here, not in the translator, so the translator stays
  // a pure event → transcript mapping.
  return useMemo((): TranscriptPort => ({
    push: (role, content, extra) => live.current.transcript.push(role, content, extra),
    appendToken: (text) => {
      setActivity('generating');
      if (live.current.prefs.read().stream) live.current.transcript.appendStream(text);
    },
    appendReasoning: (text) => {
      if (live.current.prefs.read().showReasoning) live.current.transcript.appendReasoning(text);
    },
    takeStream: () => live.current.transcript.takeStream(),
    takeReasoning: () => live.current.transcript.takeReasoning(),
    // Only `idle` is promoted. A turn started by a finished background job must
    // put the spinner up in place of the input prompt, but it must not shove the
    // setup wizard, a login prompt or a pending approval off the screen to do it
    // — those are waiting on the user, and the turn can render underneath them.
    turnStarted: () => {
      setActivity('thinking');
      setMetrics({});
      setMode(prev => (prev.type === 'idle' ? { type: 'running' } : prev));
    },
    // The turn's rollup, not the session's: the row sits under the turn you are
    // watching. `/tokens` is where the session total lives.
    reportUsage: ({ turn, durationMs, rates, ttftMs }) => {
      setMetrics({
        inputTokens: turn.inputTokens,
        outputTokens: turn.outputTokens,
        durationMs,
        cost: formatCost(turn),
        rates,
        ttftMs,
        reasoningTokens: turn.reasoningTokens,
      });
    },
    turnEnded: (outcome) => {
      live.current.setSteering(outcome === 'interrupted');
      setActivity(outcome === 'done' ? 'complete' : outcome === 'interrupted' ? 'cancelled' : 'error');
      setMode({ type: 'idle' });
    },
    requestApproval: (request) => {
      const { promise, show } = live.current.approvals.enqueue(request);
      if (show) setMode({ type: 'approval', request: show });
      return promise;
    },
    askUser: (request) => {
      const { promise, show } = live.current.questions.enqueue(request);
      if (show) setMode({ type: 'question', request: show });
      return promise;
    },
  }), []);
}
