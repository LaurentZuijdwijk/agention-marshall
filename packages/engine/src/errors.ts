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

/** Provider responses use several different spellings for an overlong prompt. */
export function isContextLengthError(message: string): boolean {
  return /context length|context.?size|maximum context|prompt.{0,30}(too long|too large|exceed)|(?:input|prompt).{0,30}token.{0,20}(limit|maximum)|token limit.{0,20}(exceed|reach)|n_ctx/i
    .test(message);
}

/**
 * Include useful response details that SDK wrappers often keep off `message`.
 * In particular, OpenAI-compatible errors retain the llama.cpp JSON body as
 * `response.error`, while the wrapper only says "Provider returned error".
 */
function errorDetails(err: unknown): string {
  if (!err || typeof err !== 'object') return '';
  const value = err as Record<string, unknown>;
  const response = value.response;
  const candidates = [
    value.statusCode,
    value.status,
    value.code,
    typeof response === 'object' && response !== null ? (response as Record<string, unknown>).status : undefined,
    typeof response === 'object' && response !== null ? (response as Record<string, unknown>).data : undefined,
    typeof response === 'object' && response !== null ? (response as Record<string, unknown>).error : undefined,
  ];
  const details = candidates
    .filter(value => value !== undefined && value !== null && value !== '')
    .map(value => typeof value === 'string' ? value : JSON.stringify(value))
    .filter(Boolean);
  return details.length > 0 ? details.join(' — ') : '';
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
  const details = errorDetails(err);
  const cleaned = raw.replace(/^llama\.cpp (?:API )?error(?: during tool response)?:\s*/i, '');
  const full = details && !cleaned.includes(details) ? `${cleaned} (${details})` : cleaned;
  const who = `${label} · ${profile.provider}/${resolveModel(profile)}`;

  if (isConnectionError(full)) {
    return `${who} — cannot reach ${endpointFor(profile)}. Is the server running and reachable?`;
  }
  if (isContextLengthError(full)) {
    return `${who} — context length exceeded. Reduce the prompt/history or lower max tokens (server response: ${full})`;
  }
  return `${who} — ${full}`;
}
