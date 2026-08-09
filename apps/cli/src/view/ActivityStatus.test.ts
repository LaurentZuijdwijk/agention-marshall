import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ActivityStatus } from './ActivityStatus.js';

/**
 * Rendering tests are intentionally kept small: the important contract is that
 * the component has one status row and exposes the derived metric in its tree.
 */
describe('ActivityStatus', () => {
  const metricRow = (props: Parameters<typeof ActivityStatus>[0]) =>
    String(((ActivityStatus(props) as any).props.children as any[])[1].props.children);

  it('shows the counts and the elapsed time', () => {
    const text = metricRow({
      state: 'complete',
      metrics: { inputTokens: 100, outputTokens: 250, durationMs: 5000 },
    });
    assert.match(text, /↑100/);
    assert.match(text, /↓250/);
    assert.match(text, /5\.0s/);
  });

  it('groups the digits of counts long enough to be misread', () => {
    const text = metricRow({ state: 'complete', metrics: { inputTokens: 1234567, outputTokens: 8901 } });
    assert.match(text, /↑1,234,567/);
    assert.match(text, /↓8,901/);
  });

  it('puts the output rate beside the count it belongs to', () => {
    // Together rather than as its own segment: the rate describes the watched
    // agent alone while the counts include sub-agents, and side by side is the
    // only arrangement where that pairing is unambiguous.
    const text = metricRow({
      state: 'generating',
      metrics: { inputTokens: 48_210, outputTokens: 3_140, rates: { output: 52.4 } },
    });
    assert.match(text, /↓3,140 ~52\.4\/s/);
  });

  it('rates the prompt too when the provider reported a clean first-token time', () => {
    const text = metricRow({
      state: 'generating',
      metrics: { inputTokens: 3_000, outputTokens: 400, rates: { input: 9677, output: 171 }, ttftMs: 310 },
    });
    assert.match(text, /↑3,000 ~9\.7k\/s/);
    assert.match(text, /↓400 ~171\/s/);
  });

  it('leaves the input count bare when the engine withheld its rate', () => {
    // Which it does for a model that thinks without streaming it: the wait
    // before the first token is mostly generation, so dividing by it is
    // meaningless. The wait itself is reported instead.
    const text = metricRow({
      state: 'generating',
      metrics: { inputTokens: 48_210, outputTokens: 3_140, rates: { output: 52.4 }, ttftMs: 1200 },
    });
    assert.match(text, /↑48,210 {2}↓/, 'the input count stands alone');
    assert.match(text, /1\.2s→1st/);
  });

  it('names the thinking share, so the rate and the count agree', () => {
    // Without it the row does not add up: 2,100 tokens at 56/s reads as 37s,
    // but only the 100 streamed ones were rated.
    const text = metricRow({
      state: 'generating',
      metrics: { inputTokens: 3_000, outputTokens: 2_100, reasoningTokens: 2_000, rates: { output: 56 }, ttftMs: 3000 },
    });
    assert.match(text, /↓2,100 \(2,000 thinking\) ~56\.0\/s/);
  });

  it('rates a provider that does not stream, and claims no first-token time', () => {
    const text = metricRow({ state: 'complete', metrics: { outputTokens: 250, rates: { output: 60 } } });
    assert.match(text, /↓250 ~60\.0\/s/);
    assert.doesNotMatch(text, /1st/);
  });

  it('shows the cost when one is known, and nothing where one is not', () => {
    const priced = metricRow({ state: 'complete', metrics: { outputTokens: 250, cost: '$0.0421' } });
    assert.match(priced, /\$0\.0421/);
    assert.doesNotMatch(metricRow({ state: 'complete', metrics: { outputTokens: 250 } }), /\$/);
  });

  it('drops the segments it has no figure for rather than naming them', () => {
    // A row of "duration unavailable · tok/s unavailable" is three words to say
    // the turn has not answered yet, in the one line the turn's own numbers want.
    const text = metricRow({ state: 'complete', metrics: { outputTokens: 250 } });
    assert.doesNotMatch(text, /unavailable/);
    assert.match(text, /↓250/);
  });

  it('says so plainly before a turn has reported anything', () => {
    assert.match(metricRow({ state: 'thinking', metrics: {} }), /no tokens yet/);
  });

  it('does not render an idle status without queued prompts', () => {
    assert.equal(ActivityStatus({ state: 'idle' }), null);
  });
});
