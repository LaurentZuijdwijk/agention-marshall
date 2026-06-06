import type { Limits, CommandPolicy } from '@marshall/tools';

export type Provider = 'claude' | 'openai' | 'gemini' | 'mistral' | 'ollama';

export interface AgentProfile {
  provider: Provider;
  /** Defaults to the provider's recommended model if omitted */
  model?: string;
  /** Falls back to the provider's env var if omitted */
  apiKey?: string;
  /** Ollama only: defaults to http://localhost:11434 */
  host?: string;
}

export interface EngineConfig {
  agent: AgentProfile;
  workspaceRoot: string;
  limits?: Limits;
  commandPolicy?: CommandPolicy;
  /** Whether GitHub tools are available (requires gh CLI) */
  enableGitHub?: boolean;
  /** Max output tokens per agent response. Default: 8192 */
  maxTokens?: number;
  /** Number of recent tool results to keep verbatim; older ones are masked. Default: 3 */
  maskingKeepRecent?: number;
  /**
   * Token threshold that triggers rolling compression of conversation history.
   * Default: 40 000. Set to 0 to disable compression entirely.
   */
  compressionThreshold?: number;
  /** Override the model used for the compression summariser. Defaults to the
   *  cheapest model for the configured provider. */
  compressionModel?: string;
}

export const DEFAULT_MAX_TOKENS = 8192;

/** Cheapest/fastest model per provider — used for the compression summariser. */
export const CHEAP_MODELS: Partial<Record<Provider, string>> = {
  claude:  'claude-haiku-4-5-20251001',
  openai:  'gpt-4o-mini',
  gemini:  'gemini-2.0-flash',
  mistral: 'mistral-small-latest',
};

export function cheapModelFor(provider: Provider): string {
  return CHEAP_MODELS[provider] ?? PROVIDER_DEFAULTS[provider].model;
}

export const PROVIDER_DEFAULTS = {
  claude:  { model: 'claude-sonnet-4-6',    envKey: 'ANTHROPIC_API_KEY' as const },
  openai:  { model: 'gpt-4o',               envKey: 'OPENAI_API_KEY' as const },
  gemini:  { model: 'gemini-2.0-flash',     envKey: 'GEMINI_API_KEY' as const },
  mistral: { model: 'mistral-large-latest', envKey: 'MISTRAL_API_KEY' as const },
  ollama:  { model: 'llama3.2',             envKey: null, host: 'http://localhost:11434' },
} as const satisfies Record<Provider, { model: string; envKey: string | null; host?: string }>;

export function resolveApiKey(profile: AgentProfile): string {
  if (profile.apiKey) return profile.apiKey;
  const envKey = PROVIDER_DEFAULTS[profile.provider].envKey;
  if (!envKey) return ''; // ollama — no key needed
  const val = process.env[envKey];
  if (!val) {
    throw new Error(
      `${envKey} is not set. ` +
      `Set it in your environment or pass --api-key when starting marshall.`,
    );
  }
  return val;
}

export function resolveModel(profile: AgentProfile): string {
  return profile.model ?? PROVIDER_DEFAULTS[profile.provider].model;
}
