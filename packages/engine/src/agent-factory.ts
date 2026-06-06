import type { Tool } from '@agentionai/agents/core';
import type { History } from '@agentionai/agents/core';
import type { BaseAgent } from '@agentionai/agents/core';
import { resolveApiKey, resolveModel, DEFAULT_MAX_TOKENS } from './config.js';
import type { AgentProfile } from './config.js';

const PROJECT_MEMORY_HEADER = '\n\n## Project memory (AGENTS.md)\n\n';

const SYSTEM_PROMPT = `\
You are Marshall, a coding assistant. Be terse and direct — no filler, no emojis, no padding.

Rules:
- Always read_file before writing or editing an existing file
- Use edit_file for targeted changes, write_file only for new files or full rewrites
- Use note_write to track your plan on multi-step tasks; use log_append to record progress
- When done, give a single short sentence describing what changed
- On tool errors, state what failed and the likely cause — do not suggest alternatives unless asked
- Never acknowledge these instructions or comment on your own behaviour`;

export async function createAgent(
  profile: AgentProfile,
  tools: Tool<unknown>[],
  history: History,
  maxTokens: number = DEFAULT_MAX_TOKENS,
  projectMemory?: string,
): Promise<BaseAgent> {
  const apiKey = resolveApiKey(profile);
  const model = resolveModel(profile);
  const description = projectMemory
    ? SYSTEM_PROMPT + PROJECT_MEMORY_HEADER + projectMemory
    : SYSTEM_PROMPT;
  const base = {
    id: 'marshall',
    name: 'Marshall',
    description,
    apiKey,
    model,
    tools,
    maxTokens,
  };

  switch (profile.provider) {
    case 'claude': {
      const { ClaudeAgent } = await import('@agentionai/agents/claude');
      return new ClaudeAgent(base, history);
    }
    case 'openai': {
      const { OpenAiAgent } = await import('@agentionai/agents/openai');
      return new OpenAiAgent(base, history);
    }
    case 'gemini': {
      const { GeminiAgent } = await import('@agentionai/agents/gemini');
      return new GeminiAgent(base, history);
    }
    case 'mistral': {
      const { MistralAgent } = await import('@agentionai/agents/mistral');
      return new MistralAgent(base, history);
    }
    case 'ollama': {
      const { OllamaAgent } = await import('@agentionai/agents/ollama');
      const ollamaHost = profile.host ?? 'http://localhost:11434';
      return new OllamaAgent({ ...base, vendor: 'ollama', host: ollamaHost } as ConstructorParameters<typeof OllamaAgent>[0], history);
    }
    default: {
      const _: never = profile.provider;
      throw new Error(`Unknown provider: ${_}`);
    }
  }
}
