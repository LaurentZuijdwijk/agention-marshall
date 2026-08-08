import { useRef } from 'react';
import type { AskRequest } from '@agentionai/marshall-tools';

/** Returned to the model when the user dismisses a question instead of answering. */
export const NO_ANSWER = '(the user did not answer)';

interface PendingQuestion { request: AskRequest; resolve: (answer: string) => void }
export type QuestionEffect = { show: AskRequest } | { show: null };
export interface Questions {
  readonly pending: number;
  enqueue(request: AskRequest): { promise: Promise<string>; show: AskRequest | null };
  resolve(answer: string): QuestionEffect | null;
  cancelAll(): number;
}
export function createQuestionQueue(): Questions {
  const queue: PendingQuestion[] = [];
  return {
    get pending() { return queue.length; },
    enqueue(request) {
      const show = queue.length === 0 ? request : null;
      const promise = new Promise<string>(resolve => queue.push({ request, resolve }));
      return { promise, show };
    },
    resolve(answer) {
      const item = queue.shift();
      if (!item) return null;
      item.resolve(answer);
      return queue.length ? { show: queue[0].request } : { show: null };
    },
    cancelAll() {
      const items = queue.splice(0);
      items.forEach(item => item.resolve(NO_ANSWER));
      return items.length;
    },
  };
}
export function useQuestions(): Questions { return useRef(createQuestionQueue()).current; }
