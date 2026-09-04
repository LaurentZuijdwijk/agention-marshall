// ── batching exact-string edits ─────────────────────────────────────────────
//
// The tool-level behaviour lives in factories/file/read-gate.test.ts. These
// cover the matching rules on their own, where a case can be stated as two
// strings rather than a workspace and an approval chain.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdits } from './apply-edits.js';

test('applies several disjoint edits in one pass', () => {
  const result = applyEdits('alpha\nbeta\ngamma\n', [
    { oldString: 'alpha', newString: 'AAA' },
    { oldString: 'gamma', newString: 'CCC' },
  ]);
  assert.ok(result.ok);
  assert.equal(result.content, 'AAA\nbeta\nCCC\n');
  assert.equal(result.applied, 2);
});

// The reason edits are located against the original and spliced from the back.
// Applied front-to-back against a running result, the second edit's recorded
// offset would point into text the first one had already moved.
test('an edit that changes length does not displace a later one', () => {
  const result = applyEdits('short\nkeep\ntarget\n', [
    { oldString: 'short', newString: 'a much longer replacement string' },
    { oldString: 'target', newString: 'hit' },
  ]);
  assert.ok(result.ok);
  assert.equal(result.content, 'a much longer replacement string\nkeep\nhit\n');
});

test('order of the edits in the call does not matter', () => {
  const forwards = applyEdits('one\ntwo\nthree\n', [
    { oldString: 'one', newString: '1' },
    { oldString: 'three', newString: '3' },
  ]);
  const backwards = applyEdits('one\ntwo\nthree\n', [
    { oldString: 'three', newString: '3' },
    { oldString: 'one', newString: '1' },
  ]);
  assert.ok(forwards.ok && backwards.ok);
  assert.equal(forwards.content, backwards.content);
});

test('reports which edit failed, by index, and reports all of them at once', () => {
  const result = applyEdits('hello world\nworld\n', [
    { oldString: 'hello', newString: 'hi' },
    { oldString: 'absent', newString: 'x' },
    { oldString: 'world', newString: 'earth' },
  ]);
  assert.ok(!result.ok);
  assert.deepEqual(result.failures.map(f => [f.index, f.reason]), [[1, 'not-found'], [2, 'ambiguous']]);
  assert.equal(result.failures.find(f => f.index === 2)?.count, 2);
});

// Nothing is written when any edit fails: a partially applied batch leaves the
// file in a state the caller never asked for and cannot easily reason about,
// having been told which edits it wanted rather than which ones landed.
test('one bad edit prevents the whole batch', () => {
  const original = 'alpha\nbeta\n';
  const result = applyEdits(original, [
    { oldString: 'alpha', newString: 'AAA' },
    { oldString: 'absent', newString: 'x' },
  ]);
  assert.ok(!result.ok);
});

test('overlapping edits are refused rather than silently corrupting each other', () => {
  const result = applyEdits('const total = a + b;\n', [
    { oldString: 'const total = a + b;', newString: 'const total = a + b + c;' },
    { oldString: 'a + b', newString: 'x + y' },
  ]);
  assert.ok(!result.ok);
  assert.equal(result.failures[0].reason, 'overlap');
});

test('edits that merely touch are not treated as overlapping', () => {
  const result = applyEdits('abcdef', [
    { oldString: 'abc', newString: 'XYZ' },
    { oldString: 'def', newString: 'UVW' },
  ]);
  assert.ok(result.ok);
  assert.equal(result.content, 'XYZUVW');
});

// A model copies oldString out of rendered output, and a quote can come back
// curled or a trailing space dropped. The text on disk is unchanged, so an
// exact match misses and the whole edit body would have to be sent again.
test('falls back to a normalized match when only quoting or trailing space differs', () => {
  const original = "const label = 'ready';   \nnext\n";
  const result = applyEdits(original, [
    { oldString: 'const label = ‘ready’;', newString: "const label = 'set';" },
  ]);
  assert.ok(result.ok);
  assert.equal(result.fuzzy, 1);
  assert.match(result.content, /const label = 'set';/);
});

test('the fallback replaces the real bytes, not the normalized ones', () => {
  // Trailing spaces are dropped when normalizing, so a naive implementation
  // would map the match back to the wrong offsets and corrupt the line after.
  const original = 'aaa   \nKEEP ME\n';
  const result = applyEdits(original, [{ oldString: 'aaa—', newString: 'bbb' }]);
  assert.ok(!result.ok, 'an em-dash that is not there must not match');
  const good = applyEdits(original, [{ oldString: 'aaa', newString: 'bbb' }]);
  assert.ok(good.ok);
  assert.equal(good.content, 'bbb   \nKEEP ME\n');
});

test('an exact match is never reinterpreted by the fallback', () => {
  // Both an exact hit and a looser one exist; the exact one must win outright.
  const result = applyEdits("x = '-';\ny = ‘—’;\n", [{ oldString: "x = '-';", newString: "x = '+';" }]);
  assert.ok(result.ok);
  assert.equal(result.fuzzy, 0);
  assert.equal(result.content, "x = '+';\ny = ‘—’;\n");
});

// Line addressing exists so an edit can be expressed with the numbers read_file
// already showed, instead of reproducing text that was never displayed raw.
test('replaces a line range addressed by the numbers read_file shows', () => {
  const result = applyEdits('one\ntwo\nthree\nfour\n', [{ startLine: 2, endLine: 3, newString: 'TWO\nTHREE\n' }]);
  assert.ok(result.ok);
  assert.equal(result.content, 'one\nTWO\nTHREE\nfour\n');
});

test('replacing a whole line does not weld it to the line below', () => {
  const result = applyEdits('a\nb\nc\n', [{ startLine: 2, endLine: 2, newString: 'B\n' }]);
  assert.ok(result.ok);
  assert.equal(result.content, 'a\nB\nc\n');
});

test('a line range reaching the last line works without a trailing newline', () => {
  const result = applyEdits('a\nb\nc', [{ startLine: 3, endLine: 3, newString: 'C' }]);
  assert.ok(result.ok);
  assert.equal(result.content, 'a\nb\nC');
});

test('line and text addressing mix in one batch, applied against the original', () => {
  const result = applyEdits('alpha\nbeta\ngamma\n', [
    { startLine: 1, endLine: 1, newString: 'ALPHA\n' },
    { oldString: 'gamma', newString: 'GAMMA' },
  ]);
  assert.ok(result.ok);
  assert.equal(result.content, 'ALPHA\nbeta\nGAMMA\n');
});

test('a line range outside the file is refused, and says how long the file is', () => {
  const result = applyEdits('a\nb\n', [{ startLine: 5, endLine: 6, newString: 'x' }]);
  assert.ok(!result.ok);
  assert.equal(result.failures[0].reason, 'bad-range');
  assert.equal(result.failures[0].lineCount, 3, 'trailing newline leaves a final empty line');
});

test('overlapping line ranges are refused like overlapping text', () => {
  const result = applyEdits('a\nb\nc\nd\n', [
    { startLine: 1, endLine: 3, newString: 'X\n' },
    { startLine: 2, endLine: 2, newString: 'Y\n' },
  ]);
  assert.ok(!result.ok);
  assert.equal(result.failures[0].reason, 'overlap');
});
