import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ActivityStatus } from './ActivityStatus.js';

/**
 * Rendering tests are intentionally kept small: the important contract is that
 * the component has one status row and exposes the derived metric in its tree.
 */
describe('ActivityStatus', () => {
  it('derives approximate output throughput from output tokens and duration', () => {
    const tree = ActivityStatus({
      state: 'complete',
      metrics: { inputTokens: 100, outputTokens: 250, durationMs: 5000 },
    }) as any;
    const children = tree.props.children as any[];
    const metricText = String(children[1].props.children);
    assert.match(metricText, /↑100/);
    assert.match(metricText, /↓250/);
    assert.match(metricText, /~50\.0 tok\/s/);
  });

  it('states when throughput telemetry is unavailable', () => {
    const tree = ActivityStatus({ state: 'complete', metrics: { outputTokens: 250 } }) as any;
    const children = tree.props.children as any[];
    assert.match(String(children[1].props.children), /tok\/s unavailable/);
  });

  it('does not render an idle status without queued prompts', () => {
    assert.equal(ActivityStatus({ state: 'idle' }), null);
  });
});
