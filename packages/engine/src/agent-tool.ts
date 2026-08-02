import { Tool } from '@agentionai/agents/core';

/** The slice of an agent this module needs — keeps the seam testable. */
export interface Executable {
  execute(instructions: string): Promise<string>;
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
  onEnd?: (call: { id: number; instructions: string; ms: number; error?: string; result?: string }) => void;
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

      try {
        const agent = await opts.spawn({ id });
        const result = await agent.execute(instructions);
        opts.onEnd?.({ id, instructions, ms: Date.now() - startedAt, result });
        return result;
      } catch (error) {
        // Sub-agent failure is reported to the caller as a result, not thrown —
        // the deep model should see it and adapt, not have its turn aborted.
        const message = error instanceof Error ? error.message : String(error);
        opts.onEnd?.({ id, instructions, ms: Date.now() - startedAt, error: message });
        return JSON.stringify({ error: `Failed to execute instructions: ${message}` });
      }
    },
  });
}
