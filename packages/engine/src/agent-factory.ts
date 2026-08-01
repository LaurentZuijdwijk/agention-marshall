import type { Tool } from '@agentionai/agents/core';
import type { History } from '@agentionai/agents/core';
import type { BaseAgent } from '@agentionai/agents/core';
import type { BuiltInTool } from '@agentionai/agents/core';
import { resolveAuth, resolveModel, DEFAULT_MAX_TOKENS, PROVIDER_DEFAULTS } from './config.js';
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

export const CONTEXT_AGENT_PROMPT = `\
You are a context-gathering assistant. Given instructions, read files, explore directories, \
and search the codebase to answer questions accurately and concisely. \
Return only what was asked for — no filler, no suggestions, no commentary.`;

export const SEARCH_AGENT_PROMPT = `\
You are a web search assistant. Search the web for the requested information and return a \
concise, well-sourced summary — key facts, dates, and source URLs. \
No filler, no suggestions, no commentary.`;

export const PLANNER_AGENT_PROMPT = `\
You are a planning assistant. Given a coding task, read whatever files you need to understand \
the codebase, then return a short ordered list of concrete steps: files to touch, what to \
change in each, and what to check afterward. Do not write or edit code yourself — plan only.`;

export const REVIEWER_AGENT_PROMPT = `\
You are a code reviewer. You'll be given a task and a summary of changes someone else made. \
Read the actual current files to verify the claim, then say either "LGTM" or a short list of \
concrete problems (bugs, missed requirements, inconsistencies). Do not edit anything yourself.`;

export const CONTEXT_TOOL_GUIDANCE =
  '\n\nPrefer the `context` tool over read_file/list_dir/search for exploring, understanding, or ' +
  'summarizing the codebase — it runs on a separate, faster model, so offloading discovery to it ' +
  'is cheaper than reading it all yourself. Reserve read_file for files you are about to edit.';

export const PLANNER_TOOL_GUIDANCE =
  '\n\nFor multi-step or multi-file tasks, call the `planner` tool first to get a concrete plan before making changes.';

export const REVIEWER_TOOL_GUIDANCE =
  '\n\nBefore giving your final answer, call the `reviewer` tool with a summary of what you changed, and address anything it flags.';

export interface CreateAgentOptions {
  /** Agent name — also becomes the tool name when wrapped via Tool.fromAgent(). Defaults to 'Marshall'. */
  name?: string;
  maxTokens?: number;
  projectMemory?: string;
  /** Appended right after the base system prompt — used to tell the agent about
   *  optional tools (planner/reviewer) that are only present in some configs. */
  extraInstructions?: string;
  systemPrompt?: string;
  /** Provider-defined server-side tools (e.g. web search). Claude only. */
  builtInTools?: BuiltInTool[];
}

export async function createAgent(
  profile: AgentProfile,
  tools: Tool<unknown>[],
  history: History,
  options: CreateAgentOptions = {},
): Promise<BaseAgent<string, string>> {
  const {
    name = 'Marshall',
    maxTokens = DEFAULT_MAX_TOKENS,
    projectMemory,
    extraInstructions,
    systemPrompt,
    builtInTools,
  } = options;
  const { key: apiKey, authType } = resolveAuth(profile);
  const model = resolveModel(profile);
  const prompt = systemPrompt ?? SYSTEM_PROMPT;
  const description =
    prompt +
    (extraInstructions ?? '') +
    (projectMemory ? PROJECT_MEMORY_HEADER + projectMemory : '');
  const base = {
    id: name.toLowerCase(),
    name,
    description,
    apiKey,
    model,
    tools,
    maxTokens,
  };

  switch (profile.provider) {
    case 'claude': {
      const { ClaudeAgent } = await import('@agentionai/agents/claude');
      return new ClaudeAgent({
        ...base,
        ...(authType === 'oauth' ? { authType } : {}),
        ...(builtInTools?.length ? { builtInTools } : {}),
      }, history);
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
    case 'llamacpp': {
      const { LlamaCppAgent } = await import('@agentionai/agents/llamacpp');
      const llamaHost = profile.host ?? 'http://localhost:8080';
      return new LlamaCppAgent({ ...base, baseURL: `${llamaHost}/v1` } as ConstructorParameters<typeof LlamaCppAgent>[0], history);
    }
    case 'openrouter': {
      // OpenRouter speaks the same OpenAI-compatible /v1/chat/completions API as
      // llama.cpp — reuse LlamaCppAgent (it's really just "OpenAI chat-completions
      // client with a configurable baseURL", not llama.cpp-specific) rather than
      // OpenAiAgent, which targets OpenAI's newer Responses API that OpenRouter
      // doesn't support.
      const { LlamaCppAgent } = await import('@agentionai/agents/llamacpp');
      const routerHost = profile.host ?? PROVIDER_DEFAULTS.openrouter.host;
      return new LlamaCppAgent({ ...base, baseURL: routerHost } as ConstructorParameters<typeof LlamaCppAgent>[0], history);
    }
    default: {
      const _: never = profile.provider;
      throw new Error(`Unknown provider: ${_}`);
    }
  }
}
