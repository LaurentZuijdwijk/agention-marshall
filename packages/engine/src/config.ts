import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Limits, CommandPolicy } from '@marshall/tools';

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
  /** Whether the agent gets Anthropic's server-side web search tool.
   *  Requires the main agent to be claude, or a searchAgent to be configured. */
  enableWebSearch?: boolean;
  /** @deprecated Use `roleProfiles.search`. Kept as an alias. */
  searchAgent?: AgentProfile;
  /** Max output tokens per agent response. Default: 8192 */
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

/** True when a role resolves to something other than the deep model. */
export function isDelegated(config: EngineConfig, role: Role): boolean {
  const deep = resolveTierProfile(config, 'deep');
  const mine = resolveRoleProfile(config, role);
  return mine.provider !== deep.provider
    || resolveModel(mine) !== resolveModel(deep)
    || mine.host !== deep.host;
}

export const DEFAULT_MAX_TOKENS = 8192;

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
