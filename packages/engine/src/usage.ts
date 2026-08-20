import type { TokenUsage } from '@agentionai/agents/core';
import { resolveModel } from './config.js';
import type { AgentProfile, Role, SwarmRole } from './config.js';

/**
 * Counting what a session spends, across every agent it runs.
 *
 * The number worth showing is the *rolled-up* one. A turn that fanned three
 * parallel `context` calls out to the fast tier looks nearly free from the
 * coder's own counter, and the coder's counter is the only thing the provider
 * hands back — so the tally has to collect from each agent separately and add
 * them up here.
 *
 * Pure and free of the session, which is what lets the arithmetic (and the
 * double-counting hazard in `record`) be tested without an agent or a provider.
 */

/**
 * Everything the tally can attribute spend to.
 *
 * Wider than `Role` because spending is not limited to the roles a user can
 * configure: a spawned agent is a real actor with a real bill, and the whole
 * point of the rollup is that no agent's tokens go uncounted. Keeping the two
 * types apart is what stops `/model` from offering to configure something that
 * is chosen per spawn — see `SwarmRole`.
 */
export type UsageRole = Role | SwarmRole;

/** Per-token USD, the shape OpenRouter publishes in its catalogue. */
export interface Pricing {
  prompt: number;
  completion: number;
}

/** Model id (as the provider names it) to its price. */
export type PriceBook = ReadonlyMap<string, Pricing>;

export interface TokenCount {
  inputTokens: number;
  outputTokens: number;
  /**
   * The share of `outputTokens` the model spent thinking, where the provider
   * breaks it out. Billed as output either way — this only says what it went on.
   */
  reasoningTokens?: number;
  /**
   * USD the provider itself billed for this reading (OpenRouter reports this
   * per call). Preferred over a price-table lookup when present, since it
   * reflects the account's actual rate — BYOK discounts, promos, whatever
   * OpenRouter did with routing — rather than a catalogue guess.
   */
  costUsd?: number;
}

export interface UsageTotals extends TokenCount {
  /** USD spent. Absent when nothing that contributed had a known price. */
  costUsd?: number;
  /**
   * Something in this total ran on a model we have no price for, so `costUsd`
   * is a floor rather than the figure. Rendered as a trailing `+`.
   */
  costPartial?: boolean;
}

export interface RoleUsage extends UsageTotals {
  role: UsageRole;
  /** `provider/model`, so two roles on the same tier are still distinguishable. */
  model: string;
}

export interface UsageReport {
  /** The turn in progress, or the one that just finished. */
  turn: UsageTotals;
  session: UsageTotals;
  /** Session spend per role and model, dearest first. */
  byRole: RoleUsage[];
}

/**
 * Providers whose tokens are free because the user is hosting the model.
 *
 * A *known* zero, not a missing price: a session running its fast tier on
 * llama.cpp should still report an exact total for what the deep tier spent,
 * rather than giving up on the arithmetic because part of it was local.
 */
const LOCAL_PROVIDERS: ReadonlySet<string> = new Set(['ollama', 'llamacpp']);

/** What one agent's tokens cost, if we can know. */
export function pricingFor(profile: AgentProfile, prices?: PriceBook): Pricing | undefined {
  if (LOCAL_PROVIDERS.has(profile.provider)) return { prompt: 0, completion: 0 };
  return prices?.get(resolveModel(profile));
}

interface Entry extends TokenCount {
  role: UsageRole;
  model: string;
  costUsd?: number;
  /** Which turn this reading belongs to, for the `turn` rollup. */
  turn: number;
}

function total(entries: Entry[]): UsageTotals {
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let costUsd = 0;
  let priced = 0;

  for (const entry of entries) {
    inputTokens += entry.inputTokens;
    outputTokens += entry.outputTokens;
    reasoningTokens += entry.reasoningTokens ?? 0;
    if (entry.costUsd === undefined) continue;
    costUsd += entry.costUsd;
    priced++;
  }

  const thinking = reasoningTokens > 0 ? { reasoningTokens } : {};

  // Nothing priced means no cost figure at all. A "$0.0000" for a provider we
  // simply have no catalogue for reads as free, which is the one thing it is not.
  if (priced === 0) return { inputTokens, outputTokens, ...thinking };
  // A floor of exactly zero says "at least nothing", which is every total ever.
  // It happens whenever the only prices we have are the free local ones — a
  // hosted deep tier and a llama.cpp fast tier, before the catalogue lands —
  // and "$0+" next to a hosted model's token count reads as almost free.
  if (costUsd === 0 && priced < entries.length) return { inputTokens, outputTokens, ...thinking };
  return {
    inputTokens,
    outputTokens,
    ...thinking,
    costUsd,
    ...(priced < entries.length ? { costPartial: true } : {}),
  };
}

function groupByRole(entries: Entry[]): RoleUsage[] {
  const groups = new Map<string, Entry[]>();
  for (const entry of entries) {
    const key = `${entry.role}\0${entry.model}`;
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  return [...groups.values()]
    .map(group => ({ role: group[0].role, model: group[0].model, ...total(group) }))
    .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || b.outputTokens - a.outputTokens);
}

export interface UsageTally {
  /**
   * Opens a new turn. Everything recorded from here counts toward `turn`.
   *
   * Returns the new turn's number, which callers put in the keys of agents that
   * live for exactly one turn — the coder's key is otherwise the same string
   * every turn, and each turn's reading would replace the last one's in the
   * session total rather than adding to it.
   */
  startTurn(): number;
  /**
   * The latest cumulative reading for one agent instance.
   *
   * Set, not added. `lastTokenUsage` already accumulates across the steps of a
   * single execute(), so a tally that added each sample would count every step
   * again for every sample taken after it — and the poll in Session.sampleUsage
   * takes a lot of samples. `key` is what makes that safe: one key per agent
   * instance, so a re-read replaces its own previous reading and nobody else's.
   */
  record(key: string, agent: { role: UsageRole; profile: AgentProfile }, usage: TokenCount): void;
  report(): UsageReport;
}

export function createUsageTally(prices: () => PriceBook | undefined = () => undefined): UsageTally {
  const entries = new Map<string, Entry>();
  let turn = 0;

  return {
    startTurn() {
      return ++turn;
    },

    record(key, { role, profile }, usage) {
      const pricing = pricingFor(profile, prices());
      const costUsd = usage.costUsd ?? (pricing
        ? usage.inputTokens * pricing.prompt + usage.outputTokens * pricing.completion
        : undefined);
      entries.set(key, {
        role,
        model: `${profile.provider}/${resolveModel(profile)}`,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ...(usage.reasoningTokens ? { reasoningTokens: usage.reasoningTokens } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
        turn,
      });
    },

    report() {
      const all = [...entries.values()];
      return {
        turn: total(all.filter(entry => entry.turn === turn)),
        session: total(all),
        byRole: groupByRole(all),
      };
    },
  };
}

// ── how long each direction actually took ─────────────────────────────────────

/**
 * Throughput for one agent, derived from what the provider reported.
 *
 * The timings themselves come from the SDK (`TokenUsage`), which measures each
 * API call from the inside and sums them across a tool-use loop — so tool
 * execution and approval waits are already excluded, and providers that report
 * their own timings (llama.cpp, Ollama) are preferred over anything measured
 * out here. What this adds is the part the raw numbers get wrong.
 */
export interface Throughput {
  /** Prompt processing. Absent when the wait before the first token was not only that. */
  input?: number;
  /** Generation of the tokens that were actually streamed. */
  output?: number;
  /** Request sent to first token back. */
  ttftMs?: number;
  /** Output tokens the provider produced without ever streaming them. */
  hiddenTokens?: number;
}

/**
 * The honest rates for one agent's usage.
 *
 * Two corrections to the SDK's own `inputTokensPerSecond` / `outputTokensPerSecond`,
 * both for the same reason: a reasoning model that does not stream its thinking
 * spends the wait before the first token *generating*, and those tokens land in
 * `output_tokens` regardless. `reasoning_tokens` is what makes this detectable —
 * providers report it precisely when the thinking is theirs to hide.
 *
 * - the output rate divides only the tokens that were streamed by the time they
 *   streamed in. Dividing all of them by that window reported a scripted
 *   2,100-token turn at 56,757 tok/s.
 * - the input rate is dropped when anything was produced off-screen, because
 *   time-to-first-token is then mostly thinking and the figure means nothing.
 *   The wait is reported as a duration instead, which is true either way.
 */
export function throughputOf(usage: TokenUsage): Throughput {
  const hidden = usage.reasoning_tokens ?? 0;
  const streamed = Math.max(0, usage.output_tokens - hidden);
  const generationMs = usage.generationMs ?? 0;
  const totalMs = usage.totalMs ?? 0;

  // Which window the tokens actually came out of. A generation window that is a
  // sliver of the call means they did not come from it: the call was spent
  // thinking and then emitted a little text. Trusting it there reported six
  // figures of tok/s — either the whole output over 9ms when the thinking was
  // undeclared, or the streamed remainder over the same 9ms when it was.
  //
  // Applied whether or not `reasoning_tokens` was reported, because the
  // subtraction fixes the numerator and this is a problem with the denominator.
  // A rate measured over a few milliseconds is noise regardless of what is
  // being divided by it.
  const streamedWindow = generationMs > 0
    && (totalMs === 0 || generationMs >= totalMs * MIN_GENERATION_SHARE);

  const output = streamedWindow
    ? rate(streamed, generationMs)
    : rate(usage.output_tokens, totalMs);

  return {
    ...(hidden === 0 && usage.inputTokensPerSecond !== undefined
      ? { input: usage.inputTokensPerSecond }
      : {}),
    ...(output !== undefined ? { output } : {}),
    ...(usage.timeToFirstTokenMs !== undefined ? { ttftMs: usage.timeToFirstTokenMs } : {}),
    ...(hidden > 0 ? { hiddenTokens: hidden } : {}),
  };
}

/**
 * How much of a call has to fall after the first token before that window is
 * taken as where the output came from.
 *
 * Only the pathological cases are near it: an ordinary streamed turn spends
 * almost all of its call generating, and a model that thinks in silence spends
 * almost none.
 */
const MIN_GENERATION_SHARE = 0.2;

/** Tokens per second, or undefined when there is nothing to divide. */
export function rate(tokens: number, ms: number): number | undefined {
  if (ms <= 0 || tokens <= 0) return undefined;
  return tokens / (ms / 1000);
}

/** `48/s`, `2.1k/s` — compact enough to sit beside the count it belongs to. */
export function formatRate(perSecond: number | undefined): string | undefined {
  if (perSecond === undefined) return undefined;
  if (perSecond >= 1000) return `${(perSecond / 1000).toFixed(1)}k/s`;
  if (perSecond >= 100) return `${Math.round(perSecond)}/s`;
  return `${perSecond.toFixed(1)}/s`;
}

/** `12,345` — token counts get long enough to be misread without the groups. */
export function formatTokens(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * `$0.0421`. Four decimals because a single turn on a cheap model rounds to
 * two, and a cost line that always reads `$0.00` is worse than none.
 */
export function formatCost(totals: UsageTotals): string | undefined {
  if (totals.costUsd === undefined) return undefined;
  const suffix = totals.costPartial ? '+' : '';
  if (totals.costUsd === 0) return `$0${suffix}`;
  if (totals.costUsd < 0.0001) return `<$0.0001${suffix}`;
  if (totals.costUsd < 1) return `$${totals.costUsd.toFixed(4)}${suffix}`;
  return `$${totals.costUsd.toFixed(2)}${suffix}`;
}
