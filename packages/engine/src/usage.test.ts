import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createUsageTally, createPhaseClock, pricingFor, rate, formatCost, formatRate, formatTokens } from './usage.js';
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

describe('PhaseClock', () => {
  /** A clock the test advances by hand, so the assertions are exact. */
  function stopwatch() {
    let t = 0;
    const clock = createPhaseClock(() => t);
    return { clock, tick: (ms: number) => { t += ms; } };
  }

  it('counts silent thinking as the working time it is', () => {
    // The bug this replaced: a model whose reasoning is not streamed back sits
    // quiet for seconds and then emits a short answer. Timing only the visible
    // chunks divided every one of its output tokens — reasoning included — by
    // the moment they took to arrive, and reported tens of thousands of tok/s.
    const { clock, tick } = stopwatch();
    clock.requestSent();
    tick(4000);          // thinking, with nothing on the wire
    clock.outputChunk();
    tick(40);            // the visible answer
    clock.outputChunk();
    clock.paused();

    const { workMs, ttftMs } = clock.read();
    assert.equal(workMs, 4040, 'the whole request was time the model was working');
    assert.equal(ttftMs, 4000, 'and the wait is reported rather than divided into');
    assert.equal(Math.round(rate(2100, workMs)!), 520, 'a believable rate for 2,100 tokens');
  });

  it('leaves tool time out, because the model is not working then', () => {
    // The other half: a turn that spends 30s running tests must not report that
    // as slow generation.
    const { clock, tick } = stopwatch();
    clock.requestSent();
    tick(500);
    clock.outputChunk();
    clock.paused();      // tool calls dispatched
    tick(30_000);        // the test suite runs
    clock.requestSent(); // tool result in, next request goes out
    tick(700);
    clock.outputChunk();
    clock.paused();

    assert.equal(clock.read().workMs, 1200);
  });

  it('dates a request from the last parallel tool to finish', () => {
    // Several tools resolve one after another and each reports; only the last
    // precedes the request that actually goes out. Counting from the first
    // would charge the gaps between them to the model.
    const { clock, tick } = stopwatch();
    clock.paused();
    clock.requestSent();
    tick(5000);
    clock.requestSent();
    tick(3000);
    clock.requestSent();
    tick(250);
    clock.outputChunk();
    clock.paused();

    assert.equal(clock.read().workMs, 250);
  });

  it('keeps the first token of the turn, not of each step', () => {
    const { clock, tick } = stopwatch();
    clock.requestSent();
    tick(1200);
    clock.outputChunk();
    clock.paused();
    clock.requestSent();
    tick(9000);          // a much slower second step
    clock.outputChunk();
    clock.paused();

    assert.equal(clock.read().ttftMs, 1200, 'time to first token is a turn-level figure');
  });

  it('counts the window still open, so a live reading is current', () => {
    const { clock, tick } = stopwatch();
    clock.requestSent();
    tick(1500);
    assert.equal(clock.read().workMs, 1500, 'still waiting, still working');
    tick(600);
    assert.equal(clock.read().workMs, 2100);
  });

  it('stops accruing once paused', () => {
    const { clock, tick } = stopwatch();
    clock.requestSent();
    tick(400);
    clock.paused();
    tick(10_000);

    assert.equal(clock.read().workMs, 400);
  });

  it('measures a provider that never streams at all', () => {
    // No chunks, so no time to first token — but the request was still
    // outstanding, and that is the whole of what the rate needs.
    const { clock, tick } = stopwatch();
    clock.requestSent();
    tick(4000);
    clock.paused();

    assert.deepEqual(clock.read(), { workMs: 4000, ttftMs: 0 });
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
