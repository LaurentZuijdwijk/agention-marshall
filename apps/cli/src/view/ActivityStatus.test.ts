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

  it('never puts a rate on the input count', () => {
    // The wait before the first token is prompt processing on one model and
    // silent thinking on the next, and nothing visible tells them apart.
    const text = metricRow({
      state: 'generating',
      metrics: { inputTokens: 48_210, outputTokens: 3_140, rates: { output: 52.4 }, ttftMs: 1200 },
    });
    assert.match(text, /↑48,210 {2}↓/, 'the input count stands alone');
    assert.match(text, /1\.2s→1st/, 'the wait itself is reported instead');
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
