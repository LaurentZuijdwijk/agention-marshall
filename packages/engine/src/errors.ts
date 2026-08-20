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
 * The provider rejected the model itself, not the size of the request.
 *
 * A 400 with no explicit context-length wording is otherwise treated as a
 * *maybe* overflow and sent through compression before being shown — see the
 * comment in `Session.run`. That guess is wrong here: no amount of shrinking
 * history fixes a model ID the provider doesn't recognise, so trying anyway
 * only spends a compression pass (and the popped last message that goes with
 * it) before landing on the same error. Checked ahead of the context guess
 * rather than folded into it, since the two are mutually exclusive — a
 * request rejected for its model was never evaluated against the context
 * window at all.
 */
export function isModelNotFoundError(message: string): boolean {
  return /no endpoints found|unknown model|invalid model|no such model|\bmodel\b.{0,60}(not found|does not exist)/i
    .test(message);
}

/**
 * The provider rejected the request because a tool call earlier in history was
 * never answered — not because the prompt was too long.
 *
 * Structurally this looks exactly like every other unlabelled 400: no
 * context-length wording, so without this check it falls through to the
 * *maybe overflow* guess and spends a compression pass shrinking a history
 * that was never too big — see the comment in `Session.run`. The actual fix
 * is structural (`Session.repairDanglingToolCalls`, which patches an
 * interrupted turn's orphaned tool call before the next request can carry
 * it), and this exists only as a backstop: if a dangling call ever gets
 * through some other way, it should be reported for what it is rather than
 * misdiagnosed as a full context window.
 *
 * Both directions of the break land here, because providers do not distinguish
 * them in the status they return: a call with no result, and a result whose
 * call is missing. Each vendor words it differently and none of the wordings
 * mention tokens, so the list is empirical — OpenAI's Responses API ("No tool
 * output found for function call"), Chat Completions ("...did not have response
 * messages", "must be a response to a preceding message with 'tool_calls'"),
 * and Azure via OpenRouter ("Missing tool call ID reference for function call
 * outputs"). Anything unmatched falls through to the maybe-overflow guess,
 * which is why the patterns are broad rather than exact.
 */
export function isDanglingToolCallError(message: string): boolean {
  return /no (?:tool )?output found for (?:function|tool) call/i.test(message)
    || /tool.?call.?ids?\b.{0,60}(?:not found|did not have|missing|no (?:matching )?response)/i.test(message)
    || /missing\b.{0,40}\btool.?call.?id/i.test(message)
    || /missing (?:a )?(?:tool|function) (?:result|output|response)/i.test(message)
    || /must be (?:a )?response.{0,40}preceding message/i.test(message)
    || /must be followed by tool messages/i.test(message);
}

/**
 * A 400 the request's *shape* earned, not its size.
 *
 * These are the ones worth naming, because the fallback below assumes any
 * unlabelled 400 might be an overflow — a guess that costs a compression pass,
 * the turn, and the popped message that goes with it. None of these get better
 * with a smaller history: a rejected schema stays rejected, a filtered prompt
 * stays filtered. Checked after `isContextLengthError`, so a provider that
 * explicitly said "context length" is believed over any wording here.
 */
export function isUnsupportedRequestError(message: string): boolean {
  return /content management policy|content[_ ]filter|responsible ai|safety system/i.test(message)
    || /invalid schema|invalid[_ ]request[_ ]error|invalid (?:value|parameter|type) for/i.test(message)
    || /unsupported (?:parameter|value|country|region)|unknown parameter|unrecognized (?:request )?argument/i.test(message)
    || /(?:is )?not supported (?:with|for|by) this model|does not support/i.test(message)
    || /invalid image|unsupported image|failed to (?:parse|decode) image/i.test(message);
}

/** How a provider failure was read, and the rule that read it that way. */
export interface ProviderErrorClass {
  kind:
    | 'connection' | 'rate-limit' | 'context-length' | 'model-not-found'
    | 'dangling-tool-call' | 'unsupported-request' | 'maybe-context' | 'other';
  /** Whether compressing history is worth attempting for this. */
  compressible: boolean;
  /** One line naming the rule that fired, for the session log. */
  reason: string;
}

/**
 * The single place that decides whether a provider failure is worth compressing
 * for — and says which rule decided it.
 *
 * Only `'context-length'` is a provider *stating* the problem. `'maybe-context'`
 * is a guess, and it exists because llama.cpp answers an overflow with a bare
 * `Provider returned error` and nothing else: requiring positive identification
 * would leave local models with no recovery at all. The cost of that guess is
 * that every 400 we have not taught this function about is treated as a maybe —
 * so the branches above it are the ones that keep it honest, and a new
 * non-overflow 400 seen in the wild belongs in one of them.
 *
 * Order is deliberate. Connection and rate-limit come first because
 * `isBadRequestError` reads any `400` in the message text and a quota payload
 * can contain one. `context-length` comes before the shape checks because a
 * provider naming the context window outranks our guess about the wording.
 */
export function classifyProviderError(err: unknown, message: string): ProviderErrorClass {
  if (isConnectionError(message)) {
    return { kind: 'connection', compressible: false, reason: 'the server could not be reached' };
  }
  if (isRateLimitError(message)) {
    return { kind: 'rate-limit', compressible: false, reason: 'rate limited or out of quota' };
  }
  if (isContextLengthError(message)) {
    return { kind: 'context-length', compressible: true, reason: 'the provider named the context window' };
  }
  if (isModelNotFoundError(message)) {
    return { kind: 'model-not-found', compressible: false, reason: 'the provider rejected the model, not the request size' };
  }
  if (isDanglingToolCallError(message)) {
    return { kind: 'dangling-tool-call', compressible: false, reason: 'a tool call and its result were not paired' };
  }
  if (isUnsupportedRequestError(message)) {
    return { kind: 'unsupported-request', compressible: false, reason: 'the request shape was rejected, which a smaller history will not fix' };
  }
  if (isBadRequestError(err)) {
    return { kind: 'maybe-context', compressible: true, reason: 'an unlabelled 400 — guessing overflow, since some providers report one without saying so' };
  }
  return { kind: 'other', compressible: false, reason: 'not a bad request and no context wording' };
}

/**
 * True for "you are asking too often, or too much this month".
 *
 * Worth its own branch because the raw text is the worst of any provider error:
 * Gemini answers a spent quota with the message, a help link, a rate-limit doc
 * link, a usage-dashboard link and a `QuotaFailure` payload, which fills the
 * transcript with about twenty lines that say one thing.
 */
export function isRateLimitError(message: string): boolean {
  return /\b429\b|too many requests|rate.?limit|RESOURCE_EXHAUSTED|quota exceeded|insufficient_quota/i
    .test(message);
}

/** How long the provider asked us to wait, in whole seconds. */
export function retryAfterSeconds(message: string): number | undefined {
  // "Please retry in 44.7s" (Google) and "Please try again in 20s" (OpenAI).
  const spoken = message.match(/(?:retry|try again)\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*(m?s)\b/i);
  const structured = message.match(/"?retryDelay"?\s*[:=]\s*"?(\d+(?:\.\d+)?)\s*(m?s)/i);
  const found = spoken ?? structured;
  if (!found) return undefined;
  const value = Number(found[1]);
  const seconds = found[2].toLowerCase() === 'ms' ? value / 1000 : value;
  return Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds)) : undefined;
}

/** `45s`, `3m`, `2h` — a wait the reader doesn't have to divide themselves. */
function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

/**
 * The quota that was actually hit, when the provider names it.
 *
 * Google's is the one worth parsing: it reports the limit, the model it applies
 * to and the window, and those three together are the difference between "wait
 * a moment" and "this model is done until tomorrow — use another one".
 */
function describeQuota(message: string): string | undefined {
  const limit = message.match(/limit:\s*(\d+)/i)?.[1] ?? message.match(/"quotaValue":\s*"?(\d+)/i)?.[1];
  if (!limit) return undefined;

  const model = message.match(/model:\s*([\w.:@/-]+)/i)?.[1];
  const window = /PerDay/i.test(message) ? 'per day'
    : /PerMinute/i.test(message) ? 'per minute'
      : undefined;
  const tier = /free.?tier/i.test(message) ? 'free-tier ' : '';

  return `${tier}quota of ${limit} requests${window ? ` ${window}` : ''}${model ? ` for ${model}` : ''}`;
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
  // Before the context-length check: a quota message can mention token limits,
  // and being told to shorten the prompt is no help when the account is capped.
  if (isRateLimitError(full)) {
    const quota = describeQuota(full);
    const wait = retryAfterSeconds(full);
    // A per-day quota is spent, not busy. The retry delay providers attach to
    // one is the generic backoff, and repeating it as advice sends the reader
    // back in a minute to fail again.
    const daily = /per day/.test(quota ?? '');
    const advice = daily
      ? ' Use another model, or raise the limit on your plan.'
      : wait ? ` Retry in ${formatWait(wait)}.` : '';
    return `${who} — rate limited by ${profile.provider}${quota ? `: ${quota} is spent.` : '.'}${advice}`;
  }
  if (isContextLengthError(full)) {
    return `${who} — context length exceeded. Reduce the prompt/history or lower max tokens (server response: ${full})`;
  }
  return `${who} — ${full}`;
}
