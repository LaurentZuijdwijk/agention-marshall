import { it } from 'node:test';
import assert from 'node:assert/strict';
import { StreamingMetrics } from './streaming-metrics.js';

it('counts cumulative text, not chunks, and measures approximate throughput', () => {
  const live = new StreamingMetrics();
  assert.equal(live.append('', 0)?.outputTokens, undefined);
  assert.equal(live.append('abcd', 100), undefined, 'a chunk 100ms after the last push is held back');
  const result = live.append('abcdefgh', 1100);
  assert.equal(result?.outputTokens, 3, 'the held-back chunk still counts');
  assert.equal(result?.outputTokensApproximate, true);
  assert.equal(result?.rates?.output, 2);
});

it('keeps growing across stale samples and takes authoritative final usage', () => {
  const live = new StreamingMetrics();
  live.append('x'.repeat(80), 0);
  assert.equal(live.report({ outputTokens: 10, inputTokens: 100 }, false).outputTokens, 20);
  assert.equal(live.append('x'.repeat(40), 1000)?.outputTokens, 30);
  const final = { outputTokens: 24, inputTokens: 100, rates: { output: 12 } };
  assert.deepEqual(live.report(final, true), final);
  live.reset();
  assert.deepEqual(live.append('', 2000), {});
  assert.equal(live.append('abcd', 3000)?.outputTokens, 1);
});

it('does not undercount reported tool or hidden reasoning tokens', () => {
  const live = new StreamingMetrics();
  live.append('abcd', 0);
  const result = live.report({ outputTokens: 200 }, false);
  assert.equal(result.outputTokens, 200);
  assert.equal(result.outputTokensApproximate, false);
});

it('leaves the provider rate alone once the provider count is the one shown', () => {
  const live = new StreamingMetrics();
  live.append('x'.repeat(40), 0);
  // 40 characters streamed, then a 60s tool call, then 40 more: the wall clock
  // spans the wait, so a char-derived rate would report a fraction of the truth.
  assert.equal(live.append('x'.repeat(40), 60_000)?.rates?.output, 10 / 60);
  const reported = live.report({ outputTokens: 5_000, rates: { output: 90 } }, false);
  assert.equal(reported.outputTokens, 5_000);
  assert.equal(reported.rates?.output, 90, 'the provider measured this count, not the estimate');
});
