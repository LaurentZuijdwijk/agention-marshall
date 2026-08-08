import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Limits, CommandPolicy } from '@agentionai/marshall-tools';
import type { McpServerConfig } from './mcp.js';

export type Provider = 'claude' | 'openai' | 'gemini' | 'mistral' | 'ollama' | 'llamacpp' | 'openrouter';

export interface AgentProfile {
  provider: Provider;
  /** Defaults to the provider's recommended model if omitted */
  model?: string;
  /** Falls back to the provider's env var if omitted */
  apiKey?: string;
  /** Ollama/llamacpp: server base URL (e.g. http://localhost:11434 or http://localhost:8080).
   *  openrouter: override for an OpenRouter-compatible gateway/proxy; defaults to openrouter.ai. */
  host?: string;
  /** OpenAI Responses API reasoning effort. Ignored by other providers. */
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

// ── model tiers ───────────────────────────────────────────────────────────────
//
// Two independent axes, kept separate on purpose:
//
//   role — what job is being done (coder, context, planner, …)
//   tier — how much horsepower that job deserves (deep vs fast)
//
// Roles bind to tiers through a small table, so adding a sub-agent costs one
// entry rather than a new config field, a new CLI flag and new wiring. Tiers
// are full AgentProfiles rather than model strings because the interesting
// setups cross providers: a hosted frontier model for `deep`, a local
// llama.cpp/Ollama model for `fast`, each with its own key and host.

export type Tier = 'deep' | 'fast';

export type Role = 'coder' | 'planner' | 'reviewer' | 'context' | 'search' | 'summarizer';

export interface ModelTiers {
  /** The strong model. Falls back to `EngineConfig.agent`. */
  deep?: AgentProfile;
  /** The cheap/quick model. Falls back to `deep` — tiering off by default. */
  fast?: AgentProfile;
}

/**
 * Which tier each role runs on unless overridden.
 *
 * The split is "who decides" vs "who fetches": reasoning about a change is
 * worth the strong model, but reading files, summarising history and running
 * searches is throughput work.
 */
export const DEFAULT_ROLE_TIERS: Record<Role, Tier> = {
  coder:      'deep',
  planner:    'deep',
  reviewer:   'deep',
  context:    'fast',
  search:     'fast',
  summarizer: 'fast',
};

// ── tool-call safety levels ─────────────────────────────────────────────────
//
//   1 — no gate: every tool call runs immediately. Dangerous; for a fully
//       sandboxed/CI setting only.
//   2 — human-in-the-loop: every state-changing tool call is confirmed by the
//       user. The default, and the only level until now.
//   3 — agent-based: a dedicated safety-review model judges each call first
//       (see `safetyAgent`). A clear "safe" verdict skips the human prompt; a
//       "unsafe" verdict still reaches the human, annotated with the model's
//       reasoning, so they can override a false positive rather than being
//       silently blocked.
export type SafetyLevel = 1 | 2 | 3;

/**
 * Which prompt/response shape `safetyAgent` speaks.
 *
 * `chat-judge` is a plain instruction-following model asked for a JSON
 * `{ decision, reason }` verdict — works with any general-purpose chat model.
 * `nvidia-content-safety` targets NVIDIA's guard-style content-safety models
 * (e.g. `nvidia/llama-3.1-nemoguard-8b-content-safety`), which are trained on a
 * safe/unsafe + category taxonomy rather than free-form instructions.
 */
export type SafetyAgentKind = 'nvidia-content-safety' | 'chat-judge';

/**
 * The model that reviews tool calls at safety level 3.
 *
 * `profile` reuses the existing provider set — there is no dedicated "nvidia"
 * provider. NVIDIA's content-safety models are served behind an OpenAI-
 * compatible API, so point `provider: 'openrouter'` (or any OpenAI-compatible
 * host) at it: `{ provider: 'openrouter', model: 'nvidia/llama-3.1-nemoguard-8b-content-safety',
 * host: 'https://integrate.api.nvidia.com/v1', apiKey: process.env.NVIDIA_API_KEY }`.
 */
export interface SafetyAgentConfig {
  profile: AgentProfile;
  /** Defaults to 'chat-judge'. */
  kind?: SafetyAgentKind;
  /**
   * Output token cap for the judge's response. Defaults to 600
   * (`DEFAULT_SAFETY_MAX_TOKENS` in safety-agent.ts) — raise it for a
   * reasoning-tuned model that emits a long chain-of-thought before its
   * verdict, or its response gets cut off mid-generation instead of parsed.
   */
  maxOutputTokens?: number;
}

export interface EngineConfig {
  agent: AgentProfile;
  workspaceRoot: string;
  /** Model tiers. `deep` defaults to `agent`, `fast` defaults to `deep`. */
  models?: ModelTiers;
  /** Per-role tier overrides, e.g. `{ reviewer: 'fast' }`. */
  roleTiers?: Partial<Record<Role, Tier>>;
  /** Per-role profile pins. Beat both `roleTiers` and `models`. */
  roleProfiles?: Partial<Record<Role, AgentProfile>>;
  limits?: Limits;
  commandPolicy?: CommandPolicy;
  /** Whether GitHub tools are available (requires gh CLI) */
  enableGitHub?: boolean;
  /**
   * Strip the belt back to the tools a small model can actually keep track of.
   *
   * Drops the scratchpad (`note_*`/`log_*`), background jobs (`run_shell`'s
   * `background` option and the `shell_*` tools) and every sub-agent
   * (`context`, `search`, `planner`, `reviewer`) — along with the prompt rules
   * and tool guidance that describe them. Roughly 1100 tokens of fixed
   * per-request overhead, which is a quarter of an 8k context window.
   *
   * Read/list/search/write/edit/run_shell remain: the set needed to do the job,
   * and no more.
   */
  light?: boolean;
  /** Whether the agent gets Anthropic's server-side web search tool.
   *  Requires the main agent to be claude, or a searchAgent to be configured. */
  enableWebSearch?: boolean;
  /** @deprecated Use `roleProfiles.search`. Kept as an alias. */
  searchAgent?: AgentProfile;
  /** Max output tokens per agent response. Omitted by default so the model's own
   *  ceiling applies; Anthropic requires one, so claude falls back to 8192. */
  maxTokens?: number;
  /** Number of recent tool results to keep verbatim; older ones are masked. Default: 3 */
  maskingKeepRecent?: number;
  /**
   * Token threshold that triggers rolling compression of conversation history.
   * Default: 40 000. Set to 0 to disable compression entirely.
   */
  compressionThreshold?: number;
  /** @deprecated Use `roleProfiles.summarizer`. Model-only override, kept as an alias. */
  compressionModel?: string;
  /** When set, the main agent gets a `context` tool backed by this agent profile.
   *  The context agent has read-only file tools and runs in its own isolated history.
   *  Presence still controls whether the tool exists; the profile itself is an
   *  alias for `roleProfiles.context`. */
  contextAgent?: AgentProfile;
  /** When set, the main agent gets a `planner` tool (read-only file access) backed by
   *  this profile, for breaking a task into steps before making changes. */
  plannerAgent?: AgentProfile;
  /** When set, the main agent gets a `reviewer` tool (read-only file access) backed by
   *  this profile, for a second opinion on changes before finishing. */
  reviewerAgent?: AgentProfile;
  /**
   * Whether a finished background shell job starts a new turn on its own.
   * Default: true.
   *
   * With it off, the job's result is still delivered — it just waits until the
   * user's next message rather than waking the agent. Turn it off for a
   * strictly turn-taking client, or where an unattended turn costs money the
   * user didn't ask to spend.
   */
  autoResume?: boolean;
  /**
   * How many turns in a row may be started by a job finishing, before the user
   * has to say something. Default: 4. Reset by every user-initiated turn.
   *
   * The cap is what stops a start-job/fail/retry cycle from running unattended
   * forever; without it, "auto-resume" and "infinite loop" are the same feature.
   */
  autoResumeBudget?: number;
  /**
   * Remote MCP servers to connect to at session start.
   *
   * Their tools are namespaced (`mcp__<server>__<tool>`) and always gated by
   * approval: unlike the builtin belt, we cannot know what a remote tool does,
   * and the server writes its own name and description.
   */
  mcpServers?: McpServerConfig[];
  /** Tool-call approval gate. Defaults to 2 (human-in-the-loop) when unset. */
  safetyLevel?: SafetyLevel;
  /** Required when `safetyLevel` is 3 — the model that reviews each call. */
  safetyAgent?: SafetyAgentConfig;
}

// ── tier resolution ───────────────────────────────────────────────────────────

/** Legacy per-role fields, treated as pins so existing configs keep working. */
const LEGACY_ROLE_PROFILES: Partial<Record<Role, keyof EngineConfig>> = {
  context:  'contextAgent',
  planner:  'plannerAgent',
  reviewer: 'reviewerAgent',
  search:   'searchAgent',
};

/**
 * The profile behind a tier.
 *
 * `fast` with nothing configured degrades to a same-provider cheap model where
 * one exists, and otherwise to `deep` — i.e. tiering is opt-in and never
 * silently routes work to a model the user didn't choose. Note that local
 * providers have no cheap alternative in `CHEAP_MODELS`, which is exactly why
 * an explicit `fast` profile matters most for llama.cpp/Ollama setups.
 */
export function resolveTierProfile(config: EngineConfig, tier: Tier): AgentProfile {
  const deep = config.models?.deep ?? config.agent;
  if (tier === 'deep') return deep;

  if (config.models?.fast) return config.models.fast;
  const cheap = cheapModelFor(deep.provider);
  return cheap ? { ...deep, model: cheap } : deep;
}

/** Which tier a role runs on, after overrides. */
export function tierForRole(config: EngineConfig, role: Role): Tier {
  return config.roleTiers?.[role] ?? DEFAULT_ROLE_TIERS[role];
}

/**
 * The profile a role should run on. Precedence, most specific first:
 *
 *   1. `roleProfiles[role]`      — explicit pin
 *   2. legacy per-role field     — `contextAgent`, `compressionModel`, …
 *   3. the role's tier           — via `roleTiers` or `DEFAULT_ROLE_TIERS`
 *
 * This answers *which model*, not *whether the role runs at all* — enablement
 * stays with the caller, so resolving a role has no side effects.
 */
export function resolveRoleProfile(config: EngineConfig, role: Role): AgentProfile {
  const pinned = config.roleProfiles?.[role];
  if (pinned) return pinned;

  const legacyKey = LEGACY_ROLE_PROFILES[role];
  if (legacyKey) {
    const legacy = config[legacyKey] as AgentProfile | undefined;
    if (legacy) return legacy;
  }

  // compressionModel is a bare model string against the main provider.
  if (role === 'summarizer' && config.compressionModel) {
    return { ...resolveTierProfile(config, 'deep'), model: config.compressionModel };
  }

  return resolveTierProfile(config, tierForRole(config, role));
}

/**
 * Whether the main agent gets a `context` tool.
 *
 * The context tool is what the fast tier is *for* — it's how file reading and
 * summarising get off the expensive model — so configuring a fast tier enables
 * it. Deliberately keyed on an explicit `models.fast` rather than
 * `isDelegated(config, 'context')`: an unconfigured fast tier auto-degrades to a
 * cheap same-provider model, and that shouldn't silently grow the toolbelt for
 * someone who never opted into tiering.
 */
export function contextToolEnabled(config: EngineConfig): boolean {
  return config.contextAgent !== undefined
    || config.roleProfiles?.context !== undefined
    || config.models?.fast !== undefined;
}

/**
 * The profile to run web search on, or null when no configured model can.
 *
 * Search is backed by Anthropic's server-side tool, so it needs a claude
 * profile. The `search` role defaults to the fast tier — which is precisely
 * where a local model gets put — so prefer the role's own profile, fall back to
 * deep when that can't search, and give up only if neither is claude.
 */
export function resolveSearchProfile(config: EngineConfig): AgentProfile | null {
  const own = resolveRoleProfile(config, 'search');
  if (own.provider === 'claude') return own;

  const deep = resolveTierProfile(config, 'deep');
  return deep.provider === 'claude' ? deep : null;
}

export interface RoleRouting {
  role: Role;
  provider: Provider;
  model: string;
  /** True when this role runs on something other than the deep model. */
  delegated: boolean;
}

/** Where every role actually lands, after tiers, overrides and legacy fields. */
export function routingSummary(config: EngineConfig): RoleRouting[] {
  return (Object.keys(DEFAULT_ROLE_TIERS) as Role[]).map(role => {
    const profile = resolveRoleProfile(config, role);
    return {
      role,
      provider: profile.provider,
      model: resolveModel(profile),
      delegated: isDelegated(config, role),
    };
  });
}

/** True when a role resolves to something other than the deep model. */
export function isDelegated(config: EngineConfig, role: Role): boolean {
  const deep = resolveTierProfile(config, 'deep');
  const mine = resolveRoleProfile(config, role);
  return mine.provider !== deep.provider
    || resolveModel(mine) !== resolveModel(deep)
    || mine.host !== deep.host;
}

export const DEFAULT_MAX_TOKENS = 8192;

/**
 * Providers whose API *rejects* a request without an output cap. Anthropic is
 * the only one; the OpenAI-compatible APIs treat `max_tokens` as optional.
 */
const REQUIRED_MAX_TOKENS: Partial<Record<Provider, number>> = {
  claude: DEFAULT_MAX_TOKENS,
};

/**
 * Cap applied when the user hasn't asked for one. Hosted providers are absent
 * on purpose: omitting the field lets the model use its own maximum, which is
 * what a long answer needs. Local servers get a ceiling anyway — without one
 * they will happily generate until the context window is exhausted.
 */
const DEFAULT_MAX_TOKENS_BY_PROVIDER: Partial<Record<Provider, number>> = {
  ...REQUIRED_MAX_TOKENS,
  llamacpp: 32768,
  ollama:   32768,
};

/**
 * The output cap to send, or `undefined` to omit the field entirely.
 *
 * A fixed 8192 was turning legitimately long answers into failures — a
 * whole-codebase `/review` died with "Response exceeded maximum token limit"
 * because the provider stopped at the cap and reported `finish_reason: length`.
 *
 * Resolved per *profile*, not once per session: with a hosted deep tier and a
 * local fast tier the right answer differs between them, so a single global
 * number would either truncate the hosted model or uncap the local one.
 *
 * An explicit positive `configured` always wins. Pass 0 to force omission,
 * which is still overridden for providers that require the field.
 */
export function resolveMaxTokens(profile: AgentProfile, configured?: number): number | undefined {
  if (configured !== undefined) {
    return configured > 0 ? configured : REQUIRED_MAX_TOKENS[profile.provider];
  }
  return DEFAULT_MAX_TOKENS_BY_PROVIDER[profile.provider];
}

/** Cheapest/fastest model per provider — used for the compression summariser. */
export const CHEAP_MODELS: Partial<Record<Provider, string>> = {
  claude:  'claude-haiku-4-5-20251001',
  openai:  'gpt-4o-mini',
  gemini:  'gemini-2.0-flash',
  mistral: 'mistral-small-latest',
};

/** Returns the cheapest model for a provider, or undefined if the provider has no meaningful cheap alternative (e.g. local servers). */
export function cheapModelFor(provider: Provider): string | undefined {
  return CHEAP_MODELS[provider];
}

export const PROVIDER_DEFAULTS = {
  claude:     { model: 'claude-sonnet-4-6',    envKey: 'ANTHROPIC_API_KEY' as const },
  openai:     { model: 'gpt-4o',               envKey: 'OPENAI_API_KEY' as const },
  gemini:     { model: 'gemini-2.0-flash',     envKey: 'GEMINI_API_KEY' as const },
  mistral:    { model: 'mistral-large-latest', envKey: 'MISTRAL_API_KEY' as const },
  ollama:     { model: 'llama3.2',             envKey: null, host: 'http://localhost:11434' },
  llamacpp:   { model: 'default',              envKey: null, host: 'http://localhost:8080'  },
  openrouter: { model: 'anthropic/claude-sonnet-4.6', envKey: 'OPENROUTER_API_KEY' as const, host: 'https://openrouter.ai/api/v1' },
} as const satisfies Record<Provider, { model: string; envKey: string | null; host?: string }>;

interface MarshallCredentials {
  accessToken: string;
  expiresAt: number;
}

function readMarshallToken(): string | null {
  try {
    const credPath = join(process.env.HOME ?? '~', '.marshall', 'credentials.json');
    if (!existsSync(credPath)) return null;
    const creds = JSON.parse(readFileSync(credPath, 'utf8')) as MarshallCredentials;
    if (!creds.accessToken) return null;
    if (Date.now() > creds.expiresAt - 60_000) {
      throw new Error('Marshall OAuth token has expired. Run `marshall login` to re-authenticate.');
    }
    return creds.accessToken;
  } catch (err) {
    if (err instanceof Error && err.message.includes('expired')) throw err;
    return null;
  }
}

export interface ResolvedAuth {
  key: string;
  /** How `key` should be presented to the provider's SDK — `'oauth'` for Marshall's
   *  stored Claude OAuth token, `'apiKey'` for everything else. */
  authType: 'apiKey' | 'oauth';
}

export function resolveAuth(profile: AgentProfile): ResolvedAuth {
  if (profile.apiKey) return { key: profile.apiKey, authType: 'apiKey' };
  const envKey = PROVIDER_DEFAULTS[profile.provider].envKey;
  if (!envKey) return { key: '', authType: 'apiKey' }; // ollama — no key needed
  const val = process.env[envKey];
  if (val) return { key: val, authType: 'apiKey' };
  // Fall back to Marshall's stored OAuth token for the claude provider.
  if (profile.provider === 'claude') {
    const token = readMarshallToken();
    if (token) return { key: token, authType: 'oauth' };
  }
  throw new Error(
    `No API key found for ${profile.provider}. ` +
    (profile.provider === 'claude'
      ? 'Run `marshall login` or set ANTHROPIC_API_KEY.'
      : `Set ${envKey} in your environment or pass --api-key.`),
  );
}

export function resolveApiKey(profile: AgentProfile): string {
  return resolveAuth(profile).key;
}

export function resolveModel(profile: AgentProfile): string {
  return profile.model ?? PROVIDER_DEFAULTS[profile.provider].model;
}
