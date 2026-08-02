import { AgentEvent } from '@agentionai/agents/core';
import type { BaseAgent, MessageContent } from '@agentionai/agents/core';

/** A slice of a streamed turn: visible prose, or the model's own reasoning. */
export interface StreamChunk {
  type: 'text' | 'reasoning';
  content: string;
}

/**
 * What an agent can be handed: plain text, or content blocks when the task
 * carries images. The library's agents accept both, but `BaseAgent<string,
 * string>` only says so for the string case — hence the narrowing here rather
 * than at every call site.
 */
export type AgentInput = string | MessageContent[];

interface AcceptsContent {
  execute(input: AgentInput): Promise<string>;
}

/**
 * The streaming half of the agent API.
 *
 * Present on Claude, OpenAI, and every OpenAI-compatible endpoint (llama.cpp,
 * OpenRouter); absent on Gemini, Mistral and Ollama, which only expose
 * `execute()`. Declared structurally rather than imported because the library
 * has no shared base type for it — the three classes each grew the method
 * independently.
 */
interface StreamingAgent {
  executeStream(input: AgentInput): AsyncGenerator<StreamChunk>;
}

function canStream(
  agent: BaseAgent<string, string>,
): agent is BaseAgent<string, string> & StreamingAgent {
  return typeof (agent as Partial<StreamingAgent>).executeStream === 'function';
}

/**
 * Run one task, streaming it to `onChunk` when the provider can, and return the
 * final answer either way.
 *
 * The two paths agree on their result: `execute()` returns the text of the last
 * assistant turn, so the streaming path has to return that too — not everything
 * the model said. A turn that calls tools streams the prose leading up to each
 * call as well, and the caller has already shown that above the tool rows;
 * returning it again would print it twice. `TOOL_USE` fires after the last chunk
 * of the turn that made the calls and before the first chunk of the next, so
 * restarting the buffer there leaves exactly the final turn's text.
 */
export async function runAgent(
  agent: BaseAgent<string, string>,
  input: AgentInput,
  onChunk: (chunk: StreamChunk) => void,
): Promise<string> {
  if (!canStream(agent)) return (agent as unknown as AcceptsContent).execute(input);

  let answer = '';
  const startTurn = () => { answer = ''; };
  agent.on(AgentEvent.TOOL_USE, startTurn);

  try {
    for await (const chunk of agent.executeStream(input)) {
      if (chunk.type === 'text') answer += chunk.content;
      onChunk(chunk);
    }
    return answer;
  } finally {
    agent.off(AgentEvent.TOOL_USE, startTurn);
  }
}
