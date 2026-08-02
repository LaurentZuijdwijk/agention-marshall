import { PROVIDER_DEFAULTS, resolveModel } from './config.js';
import type { AgentProfile } from './config.js';

/** Where a profile's requests actually go, for use in error messages. */
export function endpointFor(profile: AgentProfile): string {
  const fallback = PROVIDER_DEFAULTS[profile.provider] as { host?: string };
  return profile.host ?? fallback.host ?? profile.provider;
}

/**
 * True for "the server isn't there" rather than "the server said no".
 *
 * The provider SDKs bury this: an `ECONNREFUSED` surfaces as the rather
 * unhelpful `llama.cpp API error: Connection error.`, several `cause` levels up
 * from the address that actually refused.
 */
export function isConnectionError(message: string): boolean {
  return /connection error|fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|ECONNRESET|socket hang up/i
    .test(message);
}

/**
 * Turn a provider error into something a user can act on.
 *
 * Two problems with the raw text. It names the *class* rather than the provider
 * — `LlamaCppAgent` backs OpenRouter too, so an OpenRouter failure announces
 * itself as "llama.cpp error", which reads as the local model failing. And a
 * dead server produces "Connection error." with no mention of which host.
 */
export function describeAgentError(label: string, profile: AgentProfile, err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const cleaned = raw.replace(/^llama\.cpp (?:API )?error(?: during tool response)?:\s*/i, '');
  const who = `${label} · ${profile.provider}/${resolveModel(profile)}`;

  if (isConnectionError(cleaned)) {
    return `${who} — cannot reach ${endpointFor(profile)}. Is the server running and reachable?`;
  }
  return `${who} — ${cleaned}`;
}
