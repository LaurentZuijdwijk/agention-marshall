import { Tool } from '@agentionai/agents/core';
import type { TokenUsage } from '@agentionai/agents/core';

/**
 * What this module needs off a call's usage reading.
 *
 * A `Pick` of the SDK's own `TokenUsage` rather than a hand-written copy: the
 * fields have to keep matching what an agent actually reports, and this seam
 * exists to keep the fakes light, not to restate the type. Narrow on purpose —
 * `TokenUsage` also requires `total_tokens` and carries a dozen optional timing
 * fields no caller here reads.
 *
 * `cost_usd` earns its place: the usage tally prefers a provider-reported cost
 * to a price-table lookup, and for a sub-agent on a model missing from the
 * catalogue it is the only figure there is. Leaving it out of this type is how
 * it went missing before.
 */
export type AgentTokenUsage = Pick<TokenUsage, 'input_tokens' | 'output_tokens' | 'cost_usd'>;

/** The slice of an agent this module needs — keeps the seam testable. */
export interface Executable {
  execute(instructions: string): Promise<string>;
  /**
   * What this instance has spent, as the provider counted it. Optional because
   * not every provider reports usage, and read *after* execute rather than
   * returned by it: the SDK accumulates onto the agent across its own tool-call
   * steps, so the agent is the only thing that knows the whole call's total.
   */
  lastTokenUsage?: AgentTokenUsage;
}

export interface AgentToolOptions {
  name: string;
  description: string;
  /** Builds a *new* agent. Called once per invocation, never shared. The call
   *  id lets the caller label that agent's activity so concurrent invocations
   *  stay distinguishable in the transcript. */
  spawn: (call: { id: number }) => Promise<Executable>;
  /**
   * Called as each invocation starts and finishes. With fan-out these interleave
   * — several `start` lines before the first `end` is the parallelism being
   * visible, which is otherwise impossible to confirm from the outside.
   */
  onStart?: (call: { id: number; instructions: string }) => void;
  onEnd?: (call: {
    id: number;
    instructions: string;
    ms: number;
    error?: string;
    result?: string;
    /** Reported even when the call failed — a turn that died still cost tokens. */
    usage?: AgentTokenUsage;
  }) => void;
}

/**
 * A tool backed by a sub-agent that is built fresh for every invocation.
 *
 * `Tool.fromAgent` closes over one agent instance sharing one History — but
 * providers dispatch a turn's tool_use blocks through `Promise.all`, so two
 * calls to the same sub-agent tool run concurrently and interleave their
 * messages into that shared history. Spawning per call gives each invocation an
 * isolated agent, which both fixes that and is what lets the deep model fan
 * out: N parallel `context` calls are N independent readers.
 */
export function agentTool(opts: AgentToolOptions): Tool<string> {
  // Per-tool counter so concurrent calls are distinguishable in the log.
  let nextId = 0;

  return new Tool<string>({
    name: opts.name,
    description: opts.description,
    inputSchema: {
      type: 'object',
      properties: {
        instructions: { type: 'string', description: 'Detailed instructions for the agent.' },
      },
      required: ['instructions'],
    },
    execute: async (input: { instructions: string }) => {
      const id = nextId++;
      const instructions = input.instructions;
      const startedAt = Date.now();
      opts.onStart?.({ id, instructions });

      // Held outside the try so the failure path can still report what the call
      // spent before it died — an agent that burned its context and threw is
      // exactly the one worth seeing on the bill.
      let agent: Executable | undefined;
      try {
        agent = await opts.spawn({ id });
        const result = await agent.execute(instructions);
        opts.onEnd?.({ id, instructions, ms: Date.now() - startedAt, result, usage: agent.lastTokenUsage });
        return result;
      } catch (error) {
        // Sub-agent failure is reported to the caller as a result, not thrown —
        // the deep model should see it and adapt, not have its turn aborted.
        const message = error instanceof Error ? error.message : String(error);
        opts.onEnd?.({ id, instructions, ms: Date.now() - startedAt, error: message, usage: agent?.lastTokenUsage });
        return JSON.stringify({ error: `Failed to execute instructions: ${message}` });
      }
    },
  });
}
