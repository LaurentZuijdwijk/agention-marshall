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

/** Pure — exported so the transcript's behaviour can be tested without React. */
export function transcriptReducer(state: TranscriptState, action: TranscriptAction): TranscriptState {
  switch (action.type) {
    case 'push':
      return { ...state, messages: [...state.messages, action.message] };
    case 'reset':
      // Live buffers go too: whatever they held belonged to the cleared session.
      return { ...state, messages: action.messages, stream: '', reasoning: '' };
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
