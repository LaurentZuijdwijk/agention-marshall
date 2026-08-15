// ── resolving the model profiles ──────────────────────────────────────────────
//
// Three sources feed every profile, in this order: CLI flag → saved config →
// default. The saved config itself has two layers (the current `models.deep` /
// `models.fast` pair, and the flat pre-tier keys), which `config-store` already
// flattens for us.
//
// Pure and free of process state, so the precedence rules can be tested without
// a filesystem or an argv.

import type { AgentProfile, Provider } from '@agentionai/marshall-engine';
import { PROVIDER_DEFAULTS } from '@agentionai/marshall-engine';
import { providerCredentials, savedDeepProfile } from '../services/config-store.js';
import type { SavedConfig } from '../services/config-store.js';
import type { CliFlags } from './args.js';

/** A startup problem the user can fix — reported as a message, not a stack. */
export class StartupError extends Error {}

type ReasoningEffort = NonNullable<AgentProfile['reasoningEffort']>;
const REASONING_EFFORTS: readonly ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function checkReasoningEffort(value: string | undefined): ReasoningEffort | undefined {
  if (value === undefined) return undefined;
  if (!REASONING_EFFORTS.includes(value as ReasoningEffort)) {
    throw new StartupError(`Unknown reasoning effort "${value}". Valid: ${REASONING_EFFORTS.join(', ')}`);
  }
  return value as ReasoningEffort;
}

export interface ResolvedProfiles {
  /** The deep tier: the model that writes code, plans and reviews. */
  agentProfile: AgentProfile;
  /** The fast tier. Absent means no tiering — every role runs on the deep one. */
  fastProfile?: AgentProfile;
  contextAgentProfile?: AgentProfile;
  plannerAgentProfile?: AgentProfile;
  reviewerAgentProfile?: AgentProfile;
  maxTokens?: number;
}

function checkProvider(name: string, label: string): Provider {
  if (!Object.keys(PROVIDER_DEFAULTS).includes(name)) {
    throw new StartupError(`Unknown ${label} "${name}". Valid: ${Object.keys(PROVIDER_DEFAULTS).join(', ')}`);
  }
  return name as Provider;
}

export function resolveProfiles(flags: CliFlags, config: SavedConfig): ResolvedProfiles {
  const saved = savedDeepProfile(config);
  const provider = checkProvider(flags.provider ?? saved.provider ?? 'claude', 'provider');
  // A named endpoint belongs to the provider it was saved under. `--provider`
  // can resolve to a different one, and `saved.name` naming that other
  // provider's server would mislabel the header and misdirect the credential
  // lookup below — e.g. an openai-compatible "LM Studio" carried onto a
  // `--provider claude` run.
  const name = saved.provider === provider ? saved.name : undefined;

  // Per-endpoint last-used host/key — lets each one keep its own settings as the
  // user switches between them, instead of one flat host being overwritten.
  const savedEntry = providerCredentials(config.providers, { provider, name });
  const agentProfile: AgentProfile = {
    provider,
    ...(name ? { name } : {}),
    // undefined when given neither on the CLI nor in saved config — that is what
    // puts the App into the setup wizard on first run.
    model:  flags.model ?? saved.model,
    apiKey: flags.apiKey ?? saved.apiKey ?? savedEntry.apiKey,
    host:   flags.host   ?? saved.host   ?? savedEntry.host,
    reasoningEffort: checkReasoningEffort(flags.reasoningEffort ?? saved.reasoningEffort),
  };

  return {
    agentProfile,
    fastProfile: resolveFastProfile(flags, config, provider, agentProfile),
    // Role overrides reuse the deep tier's provider, key and host — only the
    // model differs.
    contextAgentProfile:  roleProfile(agentProfile, flags.contextModel),
    plannerAgentProfile:  roleProfile(agentProfile, flags.plannerModel),
    reviewerAgentProfile: roleProfile(agentProfile, flags.reviewerModel),
    // Only set when the user asked for it. This is one number for the whole
    // session, so filling it in from a default would pin every tier to whatever
    // suits the deep provider — a local deep tier used to hand its 32768 to a
    // hosted fast tier. Left undefined, the engine's resolveMaxTokens picks per
    // profile, which is the case it exists for.
    maxTokens: flags.maxTokens ? parseInt(flags.maxTokens, 10) : undefined,
  };
}

/**
 * The fast tier defaults to the deep tier's provider and host, since the common
 * case is a smaller model on the same server — but every part can be set
 * independently, so the two tiers can sit on entirely different providers
 * (hosted deep, local fast).
 */
function resolveFastProfile(
  flags: CliFlags,
  config: SavedConfig,
  provider: Provider,
  deep: AgentProfile,
): AgentProfile | undefined {
  const saved = config.models?.fast;
  // Validated before the model check, so a typo'd --fast-provider is reported
  // even when it would not have produced a profile.
  const fastProvider = checkProvider(flags.fastProvider ?? saved?.provider ?? provider, 'fast provider');

  const model = flags.fastModel ?? saved?.model;
  if (!model) return undefined;

  const sameProvider = fastProvider === provider;

  return {
    provider: fastProvider,
    model,
    // Only inherit the key when the tiers share a provider — a local fast tier
    // must not be handed a hosted provider's credentials.
    apiKey: sameProvider ? (flags.apiKey ?? savedDeepProfile(config).apiKey) : saved?.apiKey,
    host: flags.fastHost
      ?? saved?.host
      ?? providerCredentials(config.providers, { provider: fastProvider, name: saved?.name }).host
      ?? (sameProvider ? deep.host : undefined),
    reasoningEffort: saved?.reasoningEffort,
  };
}

function roleProfile(deep: AgentProfile, model: string | undefined): AgentProfile | undefined {
  return model ? { ...deep, model } : undefined;
}

/** What the setup wizard or the settings menu returned for one tier — a full
 *  replacement, not a merge. `provider`/`model` are `null` for the fast
 *  tier's "same as deep" row, which picks nothing of its own. */
export interface ModelChoice {
  provider: Provider | null;
  model: string | null;
  host?: string;
  apiKey?: string;
  name?: string;
}

/**
 * The profile that results from picking a new endpoint interactively — the
 * wizard-and-settings-menu counterpart to `resolveProfiles` above, which does
 * the same job for CLI flags at startup.
 *
 * Only `reasoningEffort` carries over from `carryReasoningEffortFrom`, and
 * only when the caller passes it — spreading the *whole* previous profile (as
 * this used to) let a switch to a provider or an unnamed endpoint keep the
 * old `name`, `host` or `apiKey`, none of which describe the endpoint just
 * chosen. That was this same bug's other half: `resolveProfiles` above guards
 * `name` the same way, against `saved` instead of against a fresh pick.
 */
export function chosenProfile(
  choice: ModelChoice,
  carryReasoningEffortFrom?: AgentProfile,
): AgentProfile | undefined {
  if (!choice.provider || !choice.model) return undefined;
  return {
    ...(carryReasoningEffortFrom ? { reasoningEffort: carryReasoningEffortFrom.reasoningEffort } : {}),
    provider: choice.provider,
    model: choice.model,
    host: choice.host,
    ...(choice.name ? { name: choice.name } : {}),
    ...(choice.apiKey ? { apiKey: choice.apiKey } : {}),
  };
}
