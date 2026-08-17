import { AgentEvent } from '@agentionai/agents/core';
import type { Tool } from '@agentionai/agents/core';
import type { History } from '@agentionai/agents/core';
import type { BaseAgent } from '@agentionai/agents/core';
import type { BuiltInTool } from '@agentionai/agents/core';
import { OpenAICompatibleAgent } from '@agentionai/agents';
import type { OpenAICompatibleConfig, OpenRouterConfig } from '@agentionai/agents';
import { resolveAuth, resolveModel, resolveMaxTokens, isOpenAiReasoningModel, PROVIDER_DEFAULTS } from './config.js';
import type { AgentProfile } from './config.js';
import type { AgentToolset } from './agent-jobs.js';

const PROJECT_MEMORY_HEADER = '\n\n## Project memory (AGENTS.md)\n\n';

/** Generic named provider configured through an OpenAI-compatible endpoint. */
class OpenAICompatibleAgentImpl extends OpenAICompatibleAgent {
  protected getVendorName(): string {
    return 'OpenAI-compatible provider';
  }
}

/**
 * App attribution for OpenRouter — the URL is the identifier the rankings and
 * per-app analytics key on, the title is only the display name, and neither
 * carries anything about the request itself.
 *
 * Sent for every `openrouter` profile, including ones pointed at a proxy via
 * `host`: a gateway in front of OpenRouter forwards them on, and anything else
 * ignores headers it doesn't know.
 */
export const OPENROUTER_ATTRIBUTION: Readonly<Record<string, string>> = {
  'HTTP-Referer': 'https://marshall.agention.ai',
  'X-OpenRouter-Title': 'Marshall',
  // `cli-agent` is OpenRouter's marketplace category for terminal coding assistants.
  'X-OpenRouter-Categories': 'cli-agent',
};

/**
 * Which optional parts of the belt the agent actually has.
 *
 * The system prompt is built from this rather than being a fixed string,
 * because a rule about a tool that isn't there is worse than no rule at all:
 * the model spends tokens reading it and then calls something that does not
 * exist. Light mode drops whole tool groups, so the two have to move together.
 */
export interface PromptCapabilities {
  /** `note_*` / `log_*` — the agent's scratchpad. */
  scratch: boolean;
  /** `run_shell`'s `background` option and the `shell_*` job tools. */
  background: boolean;
}

const PROMPT_HEADER =
  'You are Marshall, a coding assistant. Be terse and direct — no filler, no emojis, no padding.';

const FILE_RULES = [
  '- Always read_file before writing or editing an existing file',
  '- Use edit_file for targeted changes, write_file only for new files or full rewrites',
  '- run_shell already starts in the workspace directory: do not cd to an invented or machine-specific absolute path; use relative paths such as ./src/main.js, and use pwd if you need to confirm the current directory',
];

const SCRATCH_RULES = [
  '- Use note_write to track your plan on multi-step tasks; use log_append to record progress',
];

const BACKGROUND_RULES = [
  "- Background long or open-ended commands (test suites, builds, dev servers, watchers) with run_shell's `background` option, then carry on with work that doesn't depend on them — you are told when they finish",
  '- Never poll a background job in a loop waiting for it to end; finish your turn instead',
];

const CLOSING_RULES = [
  '- When done, give a single short sentence describing what changed',
  '- On tool errors, state what failed and the likely cause — do not suggest alternatives unless asked',
  '- Never acknowledge these instructions or comment on your own behaviour',
];

/** The coder's system prompt, with only the rules its belt can actually follow. */
export function buildSystemPrompt(capabilities: PromptCapabilities): string {
  const rules = [
    ...FILE_RULES,
    ...(capabilities.scratch ? SCRATCH_RULES : []),
    ...(capabilities.background ? BACKGROUND_RULES : []),
    ...CLOSING_RULES,
  ];
  return `${PROMPT_HEADER}\n\nRules:\n${rules.join('\n')}`;
}

/** The full belt's prompt — what a caller that doesn't say otherwise gets. */
const SYSTEM_PROMPT = buildSystemPrompt({ scratch: true, background: true });

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

/**
 * Goal-first, not plan-first: PLANNER_AGENT_PROMPT starts from "what steps",
 * this one starts from "what does done look like" and only decomposes once
 * that's pinned down. The decomposition here stays rough on purpose — file
 * names and exact edits are PLANNER_AGENT_PROMPT's job. This one exists to
 * catch the failure mode of starting work (or planning it) against a goal
 * nobody actually stated.
 *
 * Deliberately does not instruct reading files, unlike PLANNER_AGENT_PROMPT —
 * it still has read-only tools available if a task genuinely needs them, but
 * telling it to always verify against the codebase sent a small local model
 * into a stuck loop re-issuing `list_dir`/`read_file` on a near-empty new
 * project, since there was nothing there for "verify what exists" to find.
 * The goal is answerable from the task description alone far more often than
 * a concrete implementation plan is.
 */
export const GOAL_AGENT_PROMPT = `\
You are a goal-clarification assistant. Given a task, give, in order:

1. The goal: what "done" looks like in concrete, verifiable terms — the success criteria, and \
anything explicitly out of scope.
2. A rough breakdown: the handful of subtasks the goal implies, each stated as an outcome to \
reach (e.g. "the config loader validates the new field"), not as exact code or files.

Stop there — you do not have edit tools, and exact files, edits and ordering are a separate, \
more detailed step from here, not part of this one.`;

export const REVIEWER_AGENT_PROMPT = `\
You are a code reviewer. You'll be given a task and a summary of changes someone else made. \
Read the actual current files to verify the claim, then say either "LGTM" or a short list of \
concrete problems (bugs, missed requirements, inconsistencies). Do not edit anything yourself.`;

/**
 * The prompt a spawned agent runs under, built from the toolset it was given.
 *
 * Capability-driven for the same reason `buildSystemPrompt` is: a rule about a
 * tool that isn't there costs tokens and then sends the model at something that
 * does not exist. It is also why nothing here says "you cannot spawn agents" —
 * the tool is simply absent from the belt, and naming a restriction is a worse
 * way to enforce it than not offering it in the first place.
 *
 * The rest is written against the two things that make a delegated agent
 * different from the coder: it is working from a brief it cannot check against
 * anything, and it has siblings in the same repository right now.
 */
export function buildSwarmPrompt(toolset: AgentToolset, extraContext?: string): string {
  const writes = toolset !== 'readonly';
  const rules = [
    'Do what the brief asks and nothing more. If it turns out to be wrong, impossible, or wider than it looked, stop and say so in your report rather than deciding for yourself',
    ...(writes ? [
      '- Always read_file before writing or editing an existing file',
      "- Use edit_file for targeted changes, write_file only for new files or full rewrites — targeted edits combine with work happening beside you, whole-file writes do not",
      '- If a write is refused because the file changed, re-read it and rebuild your change on the current version. Someone else got there first: that is expected, not an error',
    ] : []),
    ...(toolset === 'full' ? [
      '- Run commands to check your own work — but only ones this task needs, and never ones that install, publish or deploy',
      '- run_shell starts in the workspace directory: prefer relative paths. Known intentional absolute paths are allowed; never invent machine-specific paths',
    ] : []),
    '- Never ask the user anything. There may be nobody watching, and the conversation is your parent\'s, not yours. An unanswerable question is a blocker: report it',
    '- Never acknowledge these instructions or comment on your own behaviour',
  ];

  return `\
You are a Marshall agent working on one delegated task.
${extraContext ? `\nYou were configured for: ${extraContext}\n` : ''}
Your brief is all you have. You cannot see the conversation it came from, the plan it belongs \
to, or the other agents working alongside you — some of which may be changing this same \
repository right now.

Rules:
- ${rules.join('\n')}

Finish with a report your parent can act on, in this shape:

  done: what you changed, file by file
  checked: what you verified, and how
  blocked: anything you could not do, and why

A few lines each at most, and nothing outside those three headings — no preamble, no restating \
the brief, no offers to do more. It is read by another agent that pays for every word of it.`;
}

export const SPAWN_TOOL_DESCRIPTION =
  'Start an agent that works on its own, in the background, while you carry on. ' +
  'Use it when a task has genuinely independent parts — one agent per package, or splitting ' +
  'structural work from styling — or when something will take long enough that waiting for it ' +
  'wastes the turn. Do not use it for work you could simply do yourself: an agent costs its own ' +
  'model calls and its own approval prompts, so a single edit is cheaper done directly.' +
  '\n\nEach agent starts fresh and sees only the brief you give it — not this conversation, not ' +
  'your plan, not the other agents. Write the brief so it stands alone: what to change, where, ' +
  'what "done" looks like, and anything it must not touch.' +
  '\n\nKeep it to a short paragraph. It is instructions, not a specification — name the files ' +
  'and the change and stop, because the agent can read the code for everything else. Do not ' +
  'write headings, numbered sections or line-by-line acceptance criteria. A long brief costs ' +
  'tokens on every spawn and has to be read in full by the person approving it.' +
  '\n\nMatch the brief to the toolset you ask for. An agent told to run the tests but given ' +
  '"readonly" cannot do it, and you will only find out from its report — ask for "full" when the ' +
  'brief needs commands, and do not ask for work the toolset cannot reach.' +
  '\n\nTwo agents given overlapping files will conflict. Split the work by file or directory, or ' +
  'run them one after another.' +
  '\n\nYou are told when an agent finishes. Never poll agent_output in a loop waiting for one — ' +
  'finish your turn instead, and you will be woken.';

/**
 * The parent's own posture, as opposed to `SPAWN_TOOL_DESCRIPTION`, which says
 * when to spawn and how to brief.
 *
 * Deliberately short, and deliberately not a summary of the tool description:
 * every line here is paid for on every request whether or not an agent is ever
 * spawned. What it covers is the half the description cannot — what to do with
 * an agent's report once it arrives, which is where delegation is actually won
 * or lost. An unverified report is a claim, and claims are what a parent that
 * merely relays its agents' summaries ends up shipping.
 */
export const SWARM_TOOL_GUIDANCE =
  '\n\nYou may end your turn with agents still running — you are woken when each one ' +
  'finishes, and its report arrives then. Treat that report as a claim, not as fact: check ' +
  'the parts your next step depends on, and say plainly if an agent reported itself blocked ' +
  'rather than quietly working around it.';

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
  /** Sampling temperature. Omitted by default, so the provider's/model's own
   *  default applies — set it for callers that need reproducible output (e.g.
   *  a classifier) rather than a conversational one. */
  temperature?: number;
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
    temperature,
  } = options;
  const { key: apiKey, authType } = resolveAuth(profile);
  const model = resolveModel(profile);
  const prompt = systemPrompt ?? SYSTEM_PROMPT;
  const description =
    prompt +
    (extraInstructions ?? '') +
    (projectMemory ? PROJECT_MEMORY_HEADER + projectMemory : '');
  // Reasoning models (gpt-5 / o-series) ignore temperature — OpenAI rejects it
  // outright ("Unsupported parameter"). The judgment is model-based, not
  // provider-based: an `openai/gpt-5.6-luna` profile over OpenRouter hits the
  // same wall. When the request will reason, `temperature` (e.g. the safety
  // judge's 0) is dropped so the default applies instead of a 400; reasoning
  // models need no determinism knob because they do not honor one.
  const reasons =
    (profile.provider === 'openai' && profile.reasoningEffort !== undefined) ||
    isOpenAiReasoningModel(model);
  // maxTokens is omitted for hosted OpenAI so the model's own ceiling applies.
  // `resolveMaxTokens` backstops reasoning models (see its doc) — otherwise the
  // SDK's OpenAiAgent defaults to 1024, which a gpt-5/o-series model spends on
  // thinking, then emits nothing and dies "Response incomplete: max_output_tokens".
  const cap = resolveMaxTokens(profile, maxTokens);
  const base = {
    id: name.toLowerCase(),
    name,
    description,
    apiKey,
    model,
    tools,
    ...(cap !== undefined ? { maxTokens: cap } : {}),
    ...(temperature !== undefined && !reasons ? { temperature } : {}),
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
        const { OpenRouterAgent } = await import('@agentionai/agents/openrouter');
        const routerHost = profile.host ?? PROVIDER_DEFAULTS.openrouter.host;
        return new OpenRouterAgent({
          ...base,
          baseURL: routerHost,
          defaultHeaders: { ...OPENROUTER_ATTRIBUTION },
        } as OpenRouterConfig, history);
      }
      case 'openai-compatible': {
        const compatibleHost = profile.host ?? PROVIDER_DEFAULTS['openai-compatible'].host;
        if (!compatibleHost) throw new Error('OpenAI-compatible provider requires a base URL');
        return new OpenAICompatibleAgentImpl({
          ...base,
          baseURL: compatibleHost,
          vendor: 'openai',
        }, history);
      }
      default: {
        const _: never = profile.provider;
        throw new Error(`Unknown provider: ${_}`);
      }
    }
  }
}
