import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createUsageTally, throughputOf, quotaOf, pricingFor, rate, formatCost, formatRate, formatTokens } from './usage.js';
import type { TokenUsage } from '@agentionai/agents/core';
import type { AgentProfile } from './config.js';

const CODER: AgentProfile = { provider: 'openrouter', model: 'openai/gpt-5.6-luna' };
const FAST: AgentProfile = { provider: 'llamacpp', model: 'qwen3-8b' };
const CLAUDE: AgentProfile = { provider: 'claude', model: 'claude-opus-5' };

/** $1/M in, $2/M out — round numbers so the arithmetic is checkable by eye. */
const PRICES = new Map([['openai/gpt-5.6-luna', { prompt: 0.000001, completion: 0.000002 }]]);

const spend = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens });

describe('pricingFor', () => {
  it('prices a self-hosted model at a known zero, not an unknown', () => {
    // The distinction carries: an unknown would make every total that touched
    // the fast tier a floor, when a local model genuinely costs nothing.
    assert.deepEqual(pricingFor(FAST), { prompt: 0, completion: 0 });
  });

  it('has no price for a provider that publishes none', () => {
    assert.equal(pricingFor(CLAUDE, PRICES), undefined);
  });

  it('looks a hosted model up by the id its provider knows it as', () => {
    assert.deepEqual(pricingFor(CODER, PRICES), { prompt: 0.000001, completion: 0.000002 });
  });
});

describe('UsageTally', () => {
  it('replaces an agent’s own reading instead of adding to it', () => {
    // The hazard the keys exist for: `lastTokenUsage` is already cumulative
    // across an execute(), and Session polls it twice a second. Adding each
    // sample would multiply a turn's cost by the number of times it was looked at.
    const tally = createUsageTally();
    tally.startTurn();
    tally.record('coder@1', { role: 'coder', profile: CODER }, spend(100, 50));
    tally.record('coder@1', { role: 'coder', profile: CODER }, spend(300, 200));

    assert.deepEqual(tally.report().session, spend(300, 200));
  });

  it('keeps each turn’s coder separate in the session total', () => {
    // The same bug one level up: `coder` is the same key every turn, so a tally
    // that did not namespace by turn would report only the latest turn's spend
    // as the whole session's.
    const tally = createUsageTally();
    tally.record(`coder@${tally.startTurn()}`, { role: 'coder', profile: CODER }, spend(100, 50));
    tally.record(`coder@${tally.startTurn()}`, { role: 'coder', profile: CODER }, spend(200, 100));

    const report = tally.report();
    assert.deepEqual(report.turn, spend(200, 100), 'the turn shows only its own');
    assert.deepEqual(report.session, spend(300, 150), 'the session shows both');
  });

  it('rolls sub-agents into the turn that fanned them out', () => {
    const tally = createUsageTally();
    tally.startTurn();
    tally.record('coder@1', { role: 'coder', profile: CODER }, spend(100, 50));
    tally.record('context@1', { role: 'context', profile: FAST }, spend(4000, 500));
    tally.record('context@2', { role: 'context', profile: FAST }, spend(3000, 400));

    const report = tally.report();
    assert.deepEqual(report.turn, spend(7100, 950),
      'a turn that reads through sub-agents is not a cheap turn, and with no '
      + 'catalogue loaded the free local calls alone are not a cost worth quoting');
    assert.deepEqual(report.byRole.map(r => r.role).sort(), ['coder', 'context']);
    assert.deepEqual(
      report.byRole.find(r => r.role === 'context'),
      { role: 'context', model: 'llamacpp/qwen3-8b', inputTokens: 7000, outputTokens: 900, costUsd: 0 },
      'parallel calls on one model collapse into a single line',
    );
  });

  it('costs a turn from the price of the model that ran it', () => {
    const tally = createUsageTally(() => PRICES);
    tally.startTurn();
    tally.record('coder@1', { role: 'coder', profile: CODER }, spend(1_000_000, 1_000_000));

    assert.equal(tally.report().turn.costUsd, 3);
  });

  it('totals exactly when a local tier runs alongside a priced one', () => {
    const tally = createUsageTally(() => PRICES);
    tally.startTurn();
    tally.record('coder@1', { role: 'coder', profile: CODER }, spend(1_000_000, 0));
    tally.record('context@1', { role: 'context', profile: FAST }, spend(9_000_000, 500_000));

    const { turn } = tally.report();
    assert.equal(turn.costUsd, 1);
    assert.equal(turn.costPartial, undefined, 'free is a figure, not a gap');
  });

  it('prefers a live cost reported by the provider over the price table', () => {
    // CLAUDE has no entry in PRICES, so a table lookup alone would leave this
    // reading unpriced — but a provider-reported cost (OpenRouter attaches one
    // per response) should count on its own, table or not.
    const tally = createUsageTally(() => PRICES);
    tally.startTurn();
    tally.record('coder@1', { role: 'coder', profile: CLAUDE }, { ...spend(1000, 1000), costUsd: 0.045 });

    const { turn } = tally.report();
    assert.equal(turn.costUsd, 0.045);
    assert.equal(turn.costPartial, undefined, 'a live figure is not a floor');
  });

  it('a live cost of exactly zero still counts as priced, not missing', () => {
    const tally = createUsageTally(() => PRICES);
    tally.startTurn();
    tally.record('coder@1', { role: 'coder', profile: CLAUDE }, { ...spend(1000, 1000), costUsd: 0 });

    const { turn } = tally.report();
    assert.equal(turn.costUsd, 0);
    assert.equal(turn.costPartial, undefined);
  });

  it('marks a total as a floor when something in it had no price', () => {
    const tally = createUsageTally(() => PRICES);
    tally.startTurn();
    tally.record('coder@1', { role: 'coder', profile: CODER }, spend(1_000_000, 0));
    tally.record('review@1', { role: 'reviewer', profile: CLAUDE }, spend(50_000, 9_000));

    const { turn } = tally.report();
    assert.equal(turn.costUsd, 1);
    assert.equal(turn.costPartial, true);
    assert.deepEqual(turn, { inputTokens: 1_050_000, outputTokens: 9_000, costUsd: 1, costPartial: true },
      'the tokens are still exact — it is only the money that is partial');
  });

  it('omits a floor of zero, which says nothing at all', () => {
    // Only the free local call is priced, so the "total" would be "$0 or more" —
    // true of every session ever run, and next to a hosted model's token count
    // it reads as almost free.
    const tally = createUsageTally();
    tally.startTurn();
    tally.record('coder@1', { role: 'coder', profile: CLAUDE }, spend(100_000, 50_000));
    tally.record('context@1', { role: 'context', profile: FAST }, spend(1000, 500));

    const { turn } = tally.report();
    assert.equal(turn.costUsd, undefined);
    assert.equal(turn.costPartial, undefined);
  });

  it('omits cost entirely when nothing that ran had a price', () => {
    // Not zero. "$0.00" for an unpriced provider reads as free, which is the
    // one thing it is not.
    const tally = createUsageTally();
    tally.startTurn();
    tally.record('coder@1', { role: 'coder', profile: CLAUDE }, spend(100, 50));

    assert.equal(tally.report().session.costUsd, undefined);
  });

  it('reports nothing rather than zeroes before anything has run', () => {
    const report = createUsageTally().report();
    assert.deepEqual(report.turn, spend(0, 0));
    assert.deepEqual(report.byRole, []);
  });

  it('orders the breakdown by what each role cost', () => {
    const tally = createUsageTally(() => PRICES);
    tally.startTurn();
    tally.record('context@1', { role: 'context', profile: FAST }, spend(9_000_000, 900_000));
    tally.record('coder@1', { role: 'coder', profile: CODER }, spend(1000, 1000));

    assert.deepEqual(tally.report().byRole.map(r => r.role), ['coder', 'context'],
      'the millions of local tokens are still the cheaper line');
  });
});

describe('formatCost', () => {
  it('keeps enough decimals for a single cheap turn to show up', () => {
    assert.equal(formatCost({ inputTokens: 0, outputTokens: 0, costUsd: 0.0421 }), '$0.0421');
  });

  it('says a real but negligible amount is one, rather than rounding it away', () => {
    assert.equal(formatCost({ inputTokens: 0, outputTokens: 0, costUsd: 0.00001 }), '<$0.0001');
  });

  it('drops to cents once the figure is worth reading in cents', () => {
    assert.equal(formatCost({ inputTokens: 0, outputTokens: 0, costUsd: 12.3456 }), '$12.35');
  });

  it('marks a floor with a trailing +', () => {
    assert.equal(formatCost({ inputTokens: 0, outputTokens: 0, costUsd: 0.5, costPartial: true }), '$0.5000+');
  });

  it('is absent when the cost is', () => {
    assert.equal(formatCost({ inputTokens: 1, outputTokens: 1 }), undefined);
  });

  it('distinguishes free from unknown', () => {
    assert.equal(formatCost({ inputTokens: 1, outputTokens: 1, costUsd: 0 }), '$0');
  });
});

describe('formatTokens', () => {
  it('groups digits so a six-figure count is not misread', () => {
    assert.equal(formatTokens(1234567), '1,234,567');
    assert.equal(formatTokens(0), '0');
  });
});

describe('throughputOf', () => {
  const usage = (over: Partial<TokenUsage> = {}): TokenUsage => ({
    input_tokens: 3000,
    output_tokens: 2100,
    total_tokens: 5100,
    ...over,
  });

  it('rates only the tokens that were streamed, not the ones thought in silence', () => {
    // The bug this exists for. A reasoning model spends 4s producing 2,000
    // tokens nobody sees, then streams the remaining 100 over 2s. Dividing all
    // 2,100 by that 2s claims 1,050 tok/s for a turn that wrote 100.
    const speed = throughputOf(usage({
      reasoning_tokens: 2000,
      timeToFirstTokenMs: 4000,
      generationMs: 2000,
      totalMs: 6000,
    }));

    assert.equal(speed.output, 50, '100 streamed tokens over 2s');
    assert.equal(speed.hiddenTokens, 2000);
  });

  it('falls back to the whole call when almost nothing was streamed', () => {
    // Same shape, but the visible answer lands in 9ms. The subtraction is still
    // right and the denominator is still meaningless — a rate over a few
    // milliseconds is noise whatever is divided by it.
    const speed = throughputOf(usage({
      reasoning_tokens: 2000,
      timeToFirstTokenMs: 4000,
      generationMs: 9,
      totalMs: 4009,
    }));

    assert.equal(Math.round(speed.output!), 524, 'the whole call, and all 2,100 tokens');
  });

  it('drops the input rate when anything was produced off-screen', () => {
    // Time to first token is mostly thinking there, so dividing the prompt by
    // it measures nothing. The wait is reported as a duration instead.
    const speed = throughputOf(usage({
      reasoning_tokens: 2000,
      timeToFirstTokenMs: 4000,
      generationMs: 2000,
      totalMs: 6000,
      inputTokensPerSecond: 750,
    }));

    assert.equal(speed.input, undefined);
    assert.equal(speed.ttftMs, 4000);
  });

  it('keeps the input rate when the wait really was prompt processing', () => {
    const speed = throughputOf(usage({
      reasoning_tokens: 0,
      timeToFirstTokenMs: 1400,
      generationMs: 4000,
      totalMs: 5400,
      inputTokensPerSecond: 2142.8,
    }));

    assert.equal(speed.input, 2142.8);
    assert.equal(Math.round(speed.output!), 525);
    assert.equal(speed.hiddenTokens, undefined, 'nothing was hidden');
  });

  it('falls back to the whole call when a provider hides thinking without saying so', () => {
    // No reasoning_tokens to subtract, and a generation window that is a sliver
    // of the call. Trusting that window would report 233,333 tok/s.
    const speed = throughputOf(usage({
      timeToFirstTokenMs: 4000,
      generationMs: 9,
      totalMs: 4009,
    }));

    assert.equal(Math.round(speed.output!), 524, 'the whole call is the honest denominator');
  });

  it('trusts the generation window on an ordinary streamed turn', () => {
    // Most of the call falls after the first token, so it is where the tokens
    // came from — no fallback, and no dilution by the prefill.
    const speed = throughputOf(usage({
      output_tokens: 400,
      timeToFirstTokenMs: 200,
      generationMs: 4000,
      totalMs: 4200,
    }));

    assert.equal(speed.output, 100, '400 tokens over the 4s of generation');
  });

  it('rates an unstreamed call end to end', () => {
    // No first-token mark at all, so there is no window to separate.
    const speed = throughputOf(usage({ output_tokens: 60, totalMs: 2000 }));

    assert.equal(speed.output, 30);
    assert.equal(speed.ttftMs, undefined);
  });

  it('reports nothing rather than dividing by a missing timing', () => {
    assert.deepEqual(throughputOf(usage()), {});
  });
});

describe('rate', () => {
  it('is undefined rather than infinite when no time has passed', () => {
    assert.equal(rate(100, 0), undefined);
  });

  it('is undefined when there are no tokens to rate', () => {
    assert.equal(rate(0, 1000), undefined);
  });

  it('divides tokens by seconds', () => {
    assert.equal(rate(500, 2000), 250);
  });
});

describe('formatRate', () => {
  it('keeps a decimal while the figure is small enough to need one', () => {
    assert.equal(formatRate(48.26), '48.3/s');
  });

  it('drops to whole tokens once past a hundred', () => {
    assert.equal(formatRate(482.6), '483/s');
  });

  it('switches to thousands for prompt-processing speeds', () => {
    assert.equal(formatRate(2140), '2.1k/s');
  });

  it('is absent when the rate is', () => {
    assert.equal(formatRate(undefined), undefined);
  });
});

describe('cache accounting', () => {
  it('reports a cached zero, and stays silent when the provider never mentioned caching', () => {
    // The distinction the bench turns on: a provider that says `0` has told us
    // the whole prompt was recomputed, while one that says nothing has told us
    // nothing. Collapsing both to "absent" makes an expensive prompt and an
    // unmeasured one look identical, which is how the first codex-vs-marshall
    // comparison ended up with uncomparable input-token columns.
    const tally = createUsageTally();
    tally.startTurn();
    tally.record('quiet', { role: 'coder', profile: CLAUDE }, spend(100, 50));
    assert.equal(tally.report().session.cacheReadTokens, undefined, 'nothing said');

    const measured = createUsageTally();
    measured.startTurn();
    measured.record('cold', { role: 'coder', profile: CLAUDE }, { ...spend(100, 50), cacheReadTokens: 0 });
    assert.equal(measured.report().session.cacheReadTokens, 0, 'said zero');
  });

  it('sums cache reads across agents without adding them to inputTokens', () => {
    // cacheReadTokens is a *subset* of inputTokens. Adding the two would
    // double-count every reused token and report a prompt larger than the one
    // that was sent.
    const tally = createUsageTally();
    tally.startTurn();
    tally.record('coder', { role: 'coder', profile: CODER }, { ...spend(1000, 100), cacheReadTokens: 800 });
    tally.record('context', { role: 'context', profile: CODER }, { ...spend(500, 50), cacheReadTokens: 480 });

    const session = tally.report().session;
    assert.equal(session.inputTokens, 1500, 'input is the full prompt, cache included');
    assert.equal(session.cacheReadTokens, 1280);
  });

  it('keeps a reported zero through a mix of measured and silent agents', () => {
    // One agent reporting caching is enough to make the total meaningful; the
    // silent one contributes nothing rather than poisoning it to undefined.
    const tally = createUsageTally();
    tally.startTurn();
    tally.record('measured', { role: 'coder', profile: CODER }, { ...spend(100, 10), cacheReadTokens: 0 });
    tally.record('silent', { role: 'context', profile: CLAUDE }, spend(200, 20));

    assert.equal(tally.report().session.cacheReadTokens, 0);
  });

  it('carries cache writes separately from cache reads', () => {
    const tally = createUsageTally();
    tally.startTurn();
    tally.record('coder', { role: 'coder', profile: CODER }, { ...spend(100, 10), cacheWriteTokens: 64 });

    const session = tally.report().session;
    assert.equal(session.cacheWriteTokens, 64);
    assert.equal(session.cacheReadTokens, undefined, 'a write says nothing about a read');
  });
});

describe('quotaOf', () => {
  it('is absent on a provider that bills in dollars', () => {
    // Every provider but codex reaches here as a plain BaseAgent with no
    // `lastUsageLimits` at all.
    assert.equal(quotaOf({}), undefined);
    assert.equal(quotaOf({ lastUsageLimits: undefined }), undefined);
  });

  it('converts the windows to ISO strings so the reading survives serialisation', () => {
    // The SDK hands back `Date`s. This crosses a client boundary and is written
    // into headless mode's MARSHALL_USAGE line, and a Date survives neither.
    const resetAt = new Date('2026-09-10T18:00:00.000Z');
    const at = new Date('2026-09-10T13:00:00.000Z');
    const quota = quotaOf({
      lastUsageLimits: {
        primary: { usedPercent: 1, windowMinutes: 300, resetAfterSeconds: 18000, resetAt },
        secondary: { usedPercent: 49, windowMinutes: 10080 },
        planType: 'plus',
        credits: { balance: 0, hasCredits: false },
        at,
      },
    });

    assert.deepEqual(quota, {
      primary: { usedPercent: 1, windowMinutes: 300, resetAt: '2026-09-10T18:00:00.000Z' },
      secondary: { usedPercent: 49, windowMinutes: 10080 },
      planType: 'plus',
      credits: { balance: 0, hasCredits: false },
      at: '2026-09-10T13:00:00.000Z',
    });
  });

  it('drops resetAfterSeconds, which is only true at the instant it arrived', () => {
    // The reading is not refreshed until the next API call, so a countdown
    // stored alongside it goes stale immediately while `resetAt` stays true.
    const quota = quotaOf({ lastUsageLimits: { primary: { usedPercent: 12, resetAfterSeconds: 600 }, at: new Date() } });
    assert.deepEqual(Object.keys(quota?.primary ?? {}), ['usedPercent']);
  });

  it('keeps a used-zero window rather than dropping it as empty', () => {
    // 0% used is a real state — a fresh window — and is not the same as a
    // provider that reported no window at all.
    const quota = quotaOf({ lastUsageLimits: { primary: { usedPercent: 0 }, at: new Date() } });
    assert.deepEqual(quota?.primary, { usedPercent: 0 });
  });
});
