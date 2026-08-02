import { useRef } from 'react';
import type { ApprovalRequest, ApprovalDecision } from '@marshall/tools';

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
}

/**
 * What happens to the UI after a queue operation.
 *
 * Returned rather than applied, so this hook has no opinion about modes or
 * transcripts — the caller decides what "next request" or "queue empty" means.
 */
export type QueueEffect =
  | { show: ApprovalRequest }
  | { show: null };

export interface Approvals {
  /** How many are waiting, including the one on screen. */
  readonly pending: number;
  /**
   * Queue a request and resolve when the user decides. Returns the request to
   * display, or null when one is already showing.
   */
  enqueue(request: ApprovalRequest): { promise: Promise<ApprovalDecision>; show: ApprovalRequest | null };
  /** Resolve the front request; returns what to show next. */
  resolve(decision: ApprovalDecision): QueueEffect | null;
  /** Deny everything queued. Returns how many were denied (0 if none). */
  denyAll(): number;
}

/**
 * The pending-approval queue.
 *
 * Parallel tool use means several approvals can be in flight at once — the
 * engine dispatches a turn's tool calls concurrently — so they queue and are
 * shown one at a time. A ref rather than state: the engine client is memoised
 * once and pushes into this at event time, not render time.
 */
export function createApprovalQueue(): Approvals {
  const queue: PendingApproval[] = [];

  return {
    get pending() { return queue.length; },

    enqueue(request: ApprovalRequest) {
      const wasEmpty = queue.length === 0;
      const promise = new Promise<ApprovalDecision>((resolve) => {
        queue.push({ request, resolve });
      });
      return { promise, show: wasEmpty ? request : null };
    },

    resolve(decision: ApprovalDecision): QueueEffect | null {
      const item = queue.shift();
      if (!item) return null;
      item.resolve(decision);
      return queue.length > 0 ? { show: queue[0].request } : { show: null };
    },

    denyAll(): number {
      const denied = queue.splice(0);
      for (const item of denied) item.resolve('deny');
      return denied.length;
    },
  };
}

/** One queue per mounted App, stable across renders. */
export function useApprovals(): Approvals {
  return useRef(createApprovalQueue()).current;
}
