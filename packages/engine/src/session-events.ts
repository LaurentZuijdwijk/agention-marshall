import { AgentEvent, ToolResultEvent } from '@agentionai/agents/core';
import type { BaseAgent, Tool } from '@agentionai/agents/core';
import { resolveRoleProfile, isDelegated, resolveModel } from './config.js';
import type { EngineConfig, Role } from './config.js';
import type { ClientInterface } from './types.js';

/**
 * Translating the agent SDK's events into the client's `OutputEvent` stream.
 *
 * The only thing in the engine that knows both vocabularies. Nothing here owns
 * state or makes decisions: every function is "something happened, say so",
 * which is why this is a plain factory over the three collaborators it needs
 * rather than anything with a lifecycle.
 */

/** Tool name to the role whose profile runs it — see `subagentInfo`. */
const TOOL_ROLES: Record<string, Role> = {
  context:  'context',
  search:   'search',
  planner:  'planner',
  reviewer: 'reviewer',
};

/** How much of a tool result the transcript shows for the coder's own calls. */
const RESULT_PREVIEW_CHARS = 500;
/** Sub-agent results are nested under a parent row, so they get less room. */
const SUBAGENT_RESULT_PREVIEW_CHARS = 300;

/**
 * Whether a tool result is the tool refusing rather than answering.
 *
 * Every tool in the belt reports failure by returning a string beginning
 * `Error:` instead of throwing, so this prefix is the whole contract.
 *
 * Deliberately does not count an approval denial or an interruption. Both
 * produce a result the model has to react to, but neither is the model having
 * got something wrong — folding them in here would make a log line that reads
 * "the edit failed" mean "someone declined it", and the two want different
 * responses from whoever is reading.
 */
function isFailure(result: string): boolean {
  return result.startsWith('Error:');
}

/**
 * The text an assistant message carried alongside its tool calls.
 *
 * Anthropic sends text and tool_use blocks in one content array, so the prose
 * that led up to a call is right there. The chat-completions providers emit only
 * the tool calls on this event and stream their text separately, which is why
 * this returns '' for them rather than guessing.
 *
 * Exported for tests only — the provider shapes are the whole risk here, and
 * they are far cheaper to pin down directly than through a live agent.
 */
export function assistantText(content: unknown[]): string {
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      Boolean(block) && typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim();
}

/**
 * One tool call, in either provider's shape.
 *
 * Anthropic emits `{ type: 'tool_use', name, input }`; the chat-completions
 * providers emit `{ type: 'function', function: { name, arguments } }` with the
 * arguments as an unparsed JSON string. Normalising here is what keeps both
 * listeners below from carrying the same branch twice.
 */
function toolCallsIn(content: unknown[]): { name: string; input: unknown; raw: string }[] {
  const calls: { name: string; input: unknown; raw: string }[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object' || !('type' in block)) continue;
    if (block.type === 'tool_use') {
      const b = block as unknown as { name: string; input: unknown };
      calls.push({ name: b.name, input: b.input, raw: JSON.stringify(b.input ?? {}) });
    } else if (block.type === 'function' && 'function' in block) {
      const b = block as unknown as { function: { name: string; arguments: string } };
      let input: unknown;
      try { input = JSON.parse(b.function.arguments); } catch { input = b.function.arguments; }
      calls.push({ name: b.function.name, input, raw: b.function.arguments });
    }
  }
  return calls;
}

export interface SessionEvents {
  /**
   * Mirror the coder's tool activity to the client. Returns a detach function;
   * without it the shared sub-agent tools accumulate a listener per invocation.
   */
  attachToolListeners(
    agent: BaseAgent<string, string>,
    tools: Tool<unknown>[],
    signal: AbortSignal,
    /** Names the agent when it isn't the coder — /plan and /review call tools of
     *  their own, and unlabelled those rows read as the coder's work. */
    caller?: string,
  ): () => void;

  /**
   * Mirror a spawned sub-agent's tool activity, tagged with `parent` so the
   * client can nest it under the call that owns it — and so several fanned-out
   * agents stay distinguishable while their output interleaves.
   */
  attachSubAgentListeners(
    agent: BaseAgent<string, string>,
    tools: Tool<unknown>[],
    parent: string,
  ): void;
}

export function createSessionEvents(deps: {
  client: ClientInterface;
  /** A getter, not a value: the session replaces its config on every model switch. */
  getConfig: () => EngineConfig;
  log: (line: string) => void;
}): SessionEvents {
  const { client, getConfig, log } = deps;

  /**
   * Describes an agent-backed tool, or undefined for an ordinary one.
   *
   * Reported for *every* agent-backed tool, not only the delegated ones: the
   * fact that work was handed to another agent is worth showing even when it
   * happens to run on the same model. `delegated` carries the tier distinction
   * separately.
   */
  const subagentInfo = (toolName: string): { model: string; delegated: boolean } | undefined => {
    const role = TOOL_ROLES[toolName];
    if (!role) return undefined;
    const config = getConfig();
    const profile = resolveRoleProfile(config, role);
    return {
      model: `${profile.provider}/${resolveModel(profile)}`,
      delegated: isDelegated(config, role),
    };
  };

  return {
    attachToolListeners(agent, tools, signal, caller) {
      const tag = caller ? { caller } : {};
      const onToolResult = (event: InstanceType<typeof ToolResultEvent>) => {
        if (signal.aborted) return;
        const result = String(event.result);
        // Failures are logged, not just surfaced to the client. The tools in
        // this belt report failure by *returning* a string rather than
        // throwing, so a refused edit — an oldString that matched nothing, a
        // write blocked because the file changed — left no trace at all once
        // the turn ended. That made the expensive kind of failure invisible:
        // the model pays to re-emit the whole edit body on a retry, and
        // nothing in the log said it had happened.
        if (isFailure(result)) {
          log(`TOOL_FAIL ${caller ?? 'coder'} ${event.target.name} ${result.slice(0, 300)}`);
        }
        client.onOutput({
          type: 'tool-result',
          toolName: event.target.name,
          result: result.slice(0, RESULT_PREVIEW_CHARS),
        });
      };
      for (const tool of tools) tool.on(ToolResultEvent.RESULT, onToolResult);

      agent.on(AgentEvent.TOOL_USE, (content: unknown) => {
        if (signal.aborted) return;
        if (!Array.isArray(content)) return;
        // Announced before the calls it introduces, so the transcript keeps the
        // order the model wrote them in.
        const said = assistantText(content);
        if (said) client.onOutput({ type: 'assistant', text: said });
        // Narration between tool calls is the single largest component of a
        // run's output tokens — far larger than the tool arguments — and it
        // was the one thing the log never recorded. Length only: the text
        // itself is the transcript's business, but its size is what a run's
        // cost is made of.
        log(`ASSISTANT_TEXT ${caller ?? 'coder'} ${said?.length ?? 0} chars`);
        for (const call of toolCallsIn(content)) {
          client.onOutput({
            type: 'tool-call',
            toolName: call.name,
            input: call.input,
            subagent: subagentInfo(call.name),
            ...tag,
          });
          // The full argument length alongside a truncated preview: arguments
          // are a component of a run's output-token cost, and a preview capped
          // at 200 characters cannot measure a batched edit payload that runs
          // to thousands. Logging the whole thing instead would put entire file
          // contents in the log for every write.
          log(`TOOL_CALL ${caller ?? 'coder'} ${call.name} ${call.raw.length}ch ${call.raw.slice(0, 200)}`);
        }
      });

      return () => { for (const tool of tools) tool.off(ToolResultEvent.RESULT, onToolResult); };
    },

    attachSubAgentListeners(agent, tools, parent) {
      for (const tool of tools) {
        tool.on(ToolResultEvent.RESULT, (event: InstanceType<typeof ToolResultEvent>) => {
          const result = String(event.result);
          if (isFailure(result)) {
            log(`TOOL_FAIL ${parent} ${event.target.name} ${result.slice(0, 300)}`);
          }
          client.onOutput({
            type: 'tool-result',
            toolName: event.target.name,
            result: result.slice(0, SUBAGENT_RESULT_PREVIEW_CHARS),
            parent,
          });
        });
      }

      agent.on(AgentEvent.TOOL_USE, (content: unknown) => {
        if (!Array.isArray(content)) return;
        for (const call of toolCallsIn(content)) {
          client.onOutput({ type: 'tool-call', toolName: call.name, input: call.input, parent });
        }
      });
    },
  };
}
