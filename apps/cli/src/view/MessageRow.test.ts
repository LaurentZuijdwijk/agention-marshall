import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitSafetyReason, judgeLabel } from './MessageRow.js';

// A safety row is commentary on the tool call directly above it, and says so by
// sitting under the same gutter. Wrapping breaks that: ink puts the
// continuation at column 0, so the second line reads as a new top-level event.
// Everything here is about the row staying on one line.

const JUDGE = 'ling-3.0-flash';
const FULL_LABEL = 'openrouter/inclusionai/ling-3.0-flash';

/** What the row actually costs, mirroring the JSX in MessageRow. */
function rowWidth(reason: string, judge: string, caller?: string): number {
  const gutter = '  │ '.length;
  const callerTag = caller ? `${caller} `.length : 0;
  const label = '✓ safety '.length;
  const judgeTag = judge ? `  ·  ${judge}`.length : 0;
  return gutter + callerTag + label + reason.length + judgeTag;
}

test('judgeLabel keeps the model and drops the provider path', () => {
  assert.equal(judgeLabel(FULL_LABEL), JUDGE);
});

test('judgeLabel tolerates a bare model name and a missing one', () => {
  assert.equal(judgeLabel('gpt-4o-mini'), 'gpt-4o-mini');
  assert.equal(judgeLabel(undefined), '');
});

test('a short reason is left alone', () => {
  const reason = 'routine edit';
  assert.equal(fitSafetyReason(reason, { judge: JUDGE, caller: 'coder', columns: 120 }), reason);
});

test('a long reason is cut so the row still fits one line', () => {
  const long = 'The edit targets plan.md, a planning document, and adds a new bullet point describing an agentic coding loops feature. This is routine.';
  for (const columns of [60, 80, 100, 120, 200]) {
    const fitted = fitSafetyReason(long, { judge: JUDGE, caller: 'coder', columns });
    assert.ok(
      rowWidth(fitted, JUDGE, 'coder') <= columns,
      `at ${columns} columns the row came to ${rowWidth(fitted, JUDGE, 'coder')}`,
    );
  }
});

test('the cut is marked, so a clipped reason never reads as the whole one', () => {
  const long = 'x'.repeat(400);
  const fitted = fitSafetyReason(long, { judge: JUDGE, caller: 'coder', columns: 80 });
  assert.ok(fitted.endsWith('…'), `expected an ellipsis, got ${JSON.stringify(fitted.slice(-8))}`);
});

test('a row with no caller gives that space back to the reason', () => {
  const long = 'y'.repeat(400);
  const withCaller = fitSafetyReason(long, { judge: JUDGE, caller: 'coder', columns: 80 });
  const without = fitSafetyReason(long, { judge: JUDGE, columns: 80 });
  assert.equal(without.length - withCaller.length, 'coder '.length);
});

test('a terminal too narrow for anything yields no reason rather than a negative width', () => {
  const fitted = fitSafetyReason('some reason', { judge: JUDGE, caller: 'coder', columns: 10 });
  assert.equal(fitted, '');
});
