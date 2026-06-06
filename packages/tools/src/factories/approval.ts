import { Tool } from '@agentionai/agents/core';
import type { ToolInputSchema } from '@agentionai/agents/core';
import type { ApprovalFn, ApprovalRequest, ToolSpec } from '../types.js';

const INTERRUPTED = 'Task interrupted — action was not taken.';

/**
 * Wraps a tool spec with an approval gate.
 *
 * The approval function is awaited inside the Tool's executeFn — NOT in an
 * event listener — so execution is genuinely blocked until the user decides.
 * On denial the agent gets a clear message and is told not to retry.
 *
 * Also checks the AbortSignal before and after the approval prompt so that
 * an in-flight approval is cancelled immediately when the task is interrupted.
 */
export function withApproval(
  spec: ToolSpec,
  approval: ApprovalFn,
  buildRequest: (input: Record<string, unknown>) => ApprovalRequest,
  signal?: AbortSignal,
): Tool<string> {
  return new Tool<string>({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema as unknown as ToolInputSchema,
    execute: async (input: Record<string, unknown>) => {
      if (signal?.aborted) return INTERRUPTED;

      const request = buildRequest(input);
      const decision = await approval(request);

      if (signal?.aborted) return INTERRUPTED;

      if (decision === 'deny') {
        return (
          `Action denied by user. Tool "${spec.name}" was not executed. ` +
          `Do not retry this exact action without rephrasing your approach.`
        );
      }

      return spec.execute(input);
    },
  });
}
