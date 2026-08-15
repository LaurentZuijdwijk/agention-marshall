import { useReducer, useRef, useCallback } from 'react';
import type { Message, MessageRole } from '../view/message.js';

/**
 * Everything on screen that came from the session.
 *
 * `messages` are committed rows — once rendered into <Static> they are never
 * redrawn. `stream` and `reasoning` are the live buffers, which *are* redrawn on
 * every token; keeping the boundary between the two in one place is the point of
 * this hook, because every duplicated-output bug so far has been a decision made
 * at that boundary.
 */
export interface TranscriptState {
  messages: Message[];
  stream: string;
  reasoning: string;
  /** Bumped to force a full replay of committed rows (terminal resize). */
  epoch: number;
}

export type TranscriptAction =
  | { type: 'push'; message: Message }
  | { type: 'reset'; messages: Message[] }
  | { type: 'append-stream'; text: string }
  | { type: 'clear-stream' }
  | { type: 'append-reasoning'; text: string }
  | { type: 'clear-reasoning' }
  | { type: 'replay' };

export const emptyTranscript: TranscriptState = {
  messages: [], stream: '', reasoning: '', epoch: 0,
};

/**
 * Bounds on the memory paid to retain committed reasoning in the transcript.
 *
 * The transcript mirrors the session for the viewer alone; it is display-only.
 * The model never sees it — the engine keeps its own, separately bounded
 * History — so trimming reasoning here costs nothing in model behaviour and
 * only caps what an all-day session with very long thinking traces holds in
 * the heap (the direct cause of "out of memory" after an hour of generating).
 *
 * Rows are rewritten in place (same array length, same order) because ink's
 * <Static> tracks already-emitted rows by index and would mis-render a shift.
 */
export const MAX_REASONING_PER_STEP = 4000; // chars kept per committed reasoning row (the tail)
export const MAX_REASONING_TOTAL = 60_000; // total retained reasoning chars before pruning

function boundReasoningRows(messages: Message[]): Message[] {
  let total = 0;
  let needsWork = false;
  for (const m of messages) {
    if (m.role !== 'reasoning') continue;
    total += m.content.length;
    if (m.content.length > MAX_REASONING_PER_STEP) needsWork = true;
  }
  if (!needsWork && total <= MAX_REASONING_TOTAL) return messages;

  const bounded = messages.map(m =>
    m.role !== 'reasoning' || m.content.length <= MAX_REASONING_PER_STEP
      ? m
      : { ...m, content: m.content.slice(-MAX_REASONING_PER_STEP) });

  // Prune reasoning from oldest toward newest, in place, until the total fits:
  // walk back from the most recent thinking and keep whatever fits inside the
  // budget, then flatten the rows before that boundary.
  let keepFrom = 0;
  let used = 0;
  for (let i = bounded.length - 1; i >= 0; i--) {
    if (bounded[i].role !== 'reasoning') continue;
    if (used + bounded[i].content.length <= MAX_REASONING_TOTAL) {
      used += bounded[i].content.length;
    } else {
      keepFrom = i + 1;
      break;
    }
  }
  return bounded.map((m, i) =>
    m.role !== 'reasoning' || i >= keepFrom ? m : { ...m, content: '' });
}

/** Pure — exported so the transcript's behaviour can be tested without React. */
export function transcriptReducer(state: TranscriptState, action: TranscriptAction): TranscriptState {
  switch (action.type) {
    case 'push': {
      const messages = boundReasoningRows([...state.messages, action.message]);
      return { ...state, messages };
    }
    case 'reset':
      // Live buffers go too: whatever they held belonged to the cleared session.
      //
      // The epoch bump is load-bearing, not bookkeeping. Ink's <Static> holds
      // the number of rows it has already emitted in component state and only
      // ever renders `items.slice(thatCount)`. Replacing the array with a
      // shorter one therefore renders *nothing* — the count is already past the
      // end — which is how /clear wiped the terminal and then left it empty.
      // Only a new key gives Static a fresh count, so any change that is not a
      // pure append has to change the epoch.
      return {
        ...state,
        messages: action.messages,
        stream: '',
        reasoning: '',
        epoch: state.epoch + 1,
      };
    case 'append-stream':
      return { ...state, stream: state.stream + action.text };
    case 'clear-stream':
      return state.stream === '' ? state : { ...state, stream: '' };
    case 'append-reasoning':
      return { ...state, reasoning: state.reasoning + action.text };
    case 'clear-reasoning':
      return state.reasoning === '' ? state : { ...state, reasoning: '' };
    case 'replay':
      return { ...state, epoch: state.epoch + 1 };
  }
}

export interface Transcript extends TranscriptState {
  push(role: MessageRole, content: string, extra?: Partial<Message>): void;
  reset(messages: Message[]): void;
  /** Allocate a row key without pushing — for rows built by the caller. */
  nextKey(): string;
  appendStream(text: string): void;
  clearStream(): void;
  /** Return the streamed text buffered so far and clear it, in one step. */
  takeStream(): string;
  appendReasoning(text: string): void;
  /** Return pending reasoning and clear it, in one step. */
  takeReasoning(): string;
  /** Force committed rows to be re-rendered from scratch. */
  replay(): void;
}

export function useTranscript(initial: Message[] = []): Transcript {
  const [state, dispatch] = useReducer(transcriptReducer, { ...emptyTranscript, messages: initial });

  const counter = useRef(0);
  // Mirror `stream` and `reasoning` so they can be read synchronously. Reducer
  // state is stale inside a callback, and the engine client needs the pending
  // values at the moment an event lands, not on the next render.
  const streamRef = useRef('');
  const reasoningRef = useRef('');

  const nextKey = useCallback(() => String(++counter.current), []);

  const push = useCallback((role: MessageRole, content: string, extra?: Partial<Message>) => {
    dispatch({ type: 'push', message: { key: String(++counter.current), role, content, ...extra } });
  }, []);

  const reset = useCallback((messages: Message[]) => {
    streamRef.current = '';
    reasoningRef.current = '';
    dispatch({ type: 'reset', messages });
  }, []);

  const appendStream = useCallback((text: string) => {
    streamRef.current += text;
    dispatch({ type: 'append-stream', text });
  }, []);

  const clearStream = useCallback(() => {
    streamRef.current = '';
    dispatch({ type: 'clear-stream' });
  }, []);

  const takeStream = useCallback(() => {
    const pending = streamRef.current;
    if (pending) {
      streamRef.current = '';
      dispatch({ type: 'clear-stream' });
    }
    return pending;
  }, []);

  const appendReasoning = useCallback((text: string) => {
    reasoningRef.current += text;
    dispatch({ type: 'append-reasoning', text });
  }, []);

  const takeReasoning = useCallback(() => {
    const pending = reasoningRef.current;
    if (pending) {
      reasoningRef.current = '';
      dispatch({ type: 'clear-reasoning' });
    }
    return pending;
  }, []);

  const replay = useCallback(() => dispatch({ type: 'replay' }), []);

  return {
    ...state,
    push, reset, nextKey,
    appendStream, clearStream, takeStream,
    appendReasoning, takeReasoning,
    replay,
  };
}
