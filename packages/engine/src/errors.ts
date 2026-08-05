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

/** Whether a provider error represents an HTTP 400 response. */
export function isBadRequestError(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  for (let depth = 0; current && typeof current === 'object' && depth < 5; depth++) {
    if (seen.has(current)) break;
    seen.add(current);
    const value = current as Record<string, unknown>;
    const response = value.response && typeof value.response === 'object'
      ? value.response as Record<string, unknown>
      : undefined;
    if ([value.statusCode, value.status, response?.status, response?.statusCode].some(status => status === 400 || status === '400')) {
      return true;
    }
    if (typeof value.message === 'string' && /(?:^|\D)400(?:\D|$)/.test(value.message)) return true;
    current = value.cause;
  }
  return false;
}

/**
 * Include useful response details that SDK wrappers often keep off `message`.
 * In particular, OpenAI-compatible errors retain the llama.cpp JSON body as
 * `response.error`, while the wrapper only says "Provider returned error".
 */
function errorDetails(err: unknown): string {
  const details: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;

  // The agents SDK puts the HTTP response on ApiError.response, while fetch,
  // OpenAI and gateway wrappers may put the useful body one or more `cause`
  // levels down. Walk that chain, but only record diagnostic fields — never dump
  // the complete error/request object, which could contain credentials.
  for (let depth = 0; current && typeof current === 'object' && depth < 5; depth++) {
    if (seen.has(current)) break;
    seen.add(current);
    const value = current as Record<string, unknown>;
    const response = value.response;
    const responseValue = response && typeof response === 'object'
      ? response as Record<string, unknown>
      : undefined;
    const candidates = [
      value.statusCode,
      value.status,
      value.code,
      responseValue?.status,
      responseValue?.statusCode,
      responseValue?.data,
      responseValue?.body,
      responseValue?.error,
    ];
    for (const candidate of candidates) {
      if (candidate === undefined || candidate === null || candidate === '') continue;
      const rendered = typeof candidate === 'string' ? candidate : safeJson(candidate);
      if (rendered && !details.includes(rendered)) details.push(rendered);
    }
    current = value.cause;
  }
  return details.join(' — ');
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable provider detail]';
  }
}

/** Safe provider diagnostics for the session log; excludes stacks and requests. */
export function providerErrorDiagnostics(err: unknown): string {
  const details = errorDetails(err);
  return details || (err instanceof Error ? err.name : typeof err);
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
