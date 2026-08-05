import { AgentEvent } from '@agentionai/agents/core';
import type { Tool } from '@agentionai/agents/core';
import type { History } from '@agentionai/agents/core';
import type { BaseAgent } from '@agentionai/agents/core';
import type { BuiltInTool } from '@agentionai/agents/core';
import { OpenAICompatibleAgent } from '@agentionai/agents';
import type { OpenAICompatibleConfig } from '@agentionai/agents';
import { resolveAuth, resolveModel, resolveMaxTokens, PROVIDER_DEFAULTS } from './config.js';
import type { AgentProfile } from './config.js';

const PROJECT_MEMORY_HEADER = '\n\n## Project memory (AGENTS.md)\n\n';

/** OpenRouter uses the generic chat-completions protocol, not llama.cpp. */
class OpenRouterAgent extends OpenAICompatibleAgent {
  constructor(config: OpenAICompatibleConfig, history: History) {
    super({ ...config, vendor: 'openai' }, history);
  }

  protected getVendorName(): string {
    return 'OpenRouter';
  }
}

const SYSTEM_PROMPT = `\
You are Marshall, a coding assistant. Be terse and direct — no filler, no emojis, no padding.

Rules:
- Always read_file before writing or editing an existing file
- Use edit_file for targeted changes, write_file only for new files or full rewrites
- Use note_write to track your plan on multi-step tasks; use log_append to record progress
- Background long or open-ended commands (test suites, builds, dev servers, watchers) with run_shell's \`background\` option, then carry on with work that doesn't depend on them — you are told when they finish
- Never poll a background job in a loop waiting for it to end; finish your turn instead
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
  'is cheaper than reading it all yourself. Reserve read_file for files you are about to edit.' +
  '\n\nWhen a question spans several independent areas — different directories, packages or ' +
  'subsystems — issue multiple `context` calls in a single turn, one per area, rather than one ' +
  'broad call or several sequential ones. They run in parallel on independent agents, so the ' +
  'whole survey costs about as much wall-clock time as its slowest part. Give each call a ' +
  'self-contained brief: it cannot see the others, the conversation, or your plan.';

/**
 * Context guidance for /plan and /review, which never edit.
 *
 * The coder's version says to reserve read_file for files you are about to
 * change — which for a reviewer means "never", and a reviewer that judges code
 * from someone else's summaries is a worse reviewer. So delegation here is
 * scoped to breadth: survey wide with `context`, then read the specific files
 * the verdict actually rests on.
 */
export const SURVEY_TOOL_GUIDANCE =
  '\n\nUse the `context` tool to survey breadth — it runs on a separate, faster model, so ' +
  'mapping out a directory or subsystem through it is much cheaper than reading every file ' +
  'yourself. When the scope spans several directories or packages, issue one `context` call ' +
  'per area in a single turn: they run in parallel on independent agents, so the whole survey ' +
  'costs about as much time as its slowest part. Give each call a self-contained brief — it ' +
  'cannot see the others or this conversation.' +
  '\n\nThen read the specific files your conclusions actually rest on with read_file. Do not ' +
  'assert a bug, or sign off on correctness, based only on a summary — verify that claim ' +
  'against the real source first.';

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
    maxTokens,
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
  // Omitted entirely when the provider doesn't require it, so the model's own
  // ceiling applies instead of an arbitrary cap that truncates long answers.
  const cap = resolveMaxTokens(profile, maxTokens);
  const base = {
    id: name.toLowerCase(),
    name,
    description,
    apiKey,
    model,
    tools,
    ...(cap !== undefined ? { maxTokens: cap } : {}),
    ...(profile.provider === 'openai' && profile.reasoningEffort !== undefined
      ? { reasoningEffort: profile.reasoningEffort }
      : {}),
  };

  const agent = await instantiate();

  // EventEmitter contract: emitting 'error' with no listener attached throws as
  // an uncaught exception and takes the process down. These agents emit 'error'
  // *in addition* to rejecting their promise, so catching the rejection is not
  // enough — a llama.cpp server going away mid-compression crashed the whole CLI.
  // Every agent therefore gets a safety net here; callers that want to report the
  // failure add their own listener on top, and the rejection stays the reporting
  // path. Swallowing here loses nothing: the same error arrives as a rejection.
  agent.on(AgentEvent.ERROR, () => {});

  return agent;

  // Declared after the return purely so the interesting part — the safety net —
  // reads first; hoisting makes it available above.
  async function instantiate(): Promise<BaseAgent<string, string>> {
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
        const routerHost = profile.host ?? PROVIDER_DEFAULTS.openrouter.host;
        return new OpenRouterAgent({
          ...base,
          baseURL: routerHost,
        } as OpenAICompatibleConfig, history);
      }
      default: {
        const _: never = profile.provider;
        throw new Error(`Unknown provider: ${_}`);
      }
    }
  }
}
