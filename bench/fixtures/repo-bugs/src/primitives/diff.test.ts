import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatFileDiff, diffLines, diffStats, describeDiff } from './diff.js';

/** A file long enough that its tail sits far past any content-prefix preview. */
function longFile(marker = 'const flag = false;'): string {
  const lines = Array.from({ length: 400 }, (_, i) => `line ${i}: some ordinary source content here`);
  lines[300] = marker;
  return lines.join('\n');
}

// The reason this module exists. `write_file` used to show the first 800
// characters of its new content, so a change past that point was never
// rendered: rewriting a whole file was a way to make an edit the approval panel
// could not show. A diff has to surface that change no matter where it sits.
test('a change buried far past a content preview still shows up', () => {
  const before = longFile('const flag = false;');
  const after = longFile('const flag = true;  // quietly flipped');

  // The old rendering: identical for both, so the panel showed nothing useful.
  assert.equal(before.slice(0, 800), after.slice(0, 800),
    'precondition: the first 800 characters are unchanged, which is the whole exploit');

  const { text, stats } = formatFileDiff('config.ts', before, after);
  assert.match(text, /quietly flipped/, 'the changed line must be rendered');
  assert.match(text, /- const flag = false;/);
  assert.equal(stats.added, 1);
  assert.equal(stats.removed, 1);
});

test('the rendering scales with the change, not the file', () => {
  const before = longFile();
  const after = longFile('changed');
  const { text } = formatFileDiff('config.ts', before, after);
  assert.ok(text.split('\n').length < 20,
    `a one-line change in a 400-line file should render small, got ${text.split('\n').length} lines`);
});

test('an identical write is reported as changing nothing', () => {
  const same = longFile();
  const { text, stats } = formatFileDiff('config.ts', same, same);
  assert.match(text, /no changes/);
  assert.equal(stats.added, 0);
  assert.equal(stats.removed, 0);
});

test('creating content from nothing is all additions', () => {
  const { stats } = formatFileDiff('new.ts', '', 'one\ntwo\nthree');
  assert.equal(stats.added, 3);
  assert.equal(stats.removed, 1, 'the empty original counts as one empty line');
});

test('scattered changes are all reported, or the count of what was cut is', () => {
  const before = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
  const after = before.split('\n').map((l, i) => (i % 10 === 0 ? `${l} CHANGED` : l)).join('\n');

  const { text, stats } = formatFileDiff('spread.ts', before, after, 20);
  assert.equal(stats.added, 20);
  assert.equal(stats.removed, 20);
  // Truncation is honest here in a way a content prefix never was: the reader
  // is told changes exist beyond what is shown.
  assert.match(text, /further changed lines not shown/);
});

test('unchanged runs are summarised rather than printed', () => {
  const before = longFile();
  const after = longFile('changed');
  const { text } = formatFileDiff('config.ts', before, after);
  assert.match(text, /@@ \d+ unchanged lines @@/);
});

test('describeDiff states the shape of a write', () => {
  const ops = diffLines('a\nb\nc', 'a\nB\nc');
  assert.equal(describeDiff(diffStats(ops)), '+1 −1, 2 unchanged');
  assert.equal(describeDiff({ added: 0, removed: 0, unchanged: 10 }), 'no changes');
});

test('a wholesale rewrite is still bounded work', () => {
  const before = Array.from({ length: 3000 }, (_, i) => `old ${i}`).join('\n');
  const after = Array.from({ length: 3000 }, (_, i) => `new ${i}`).join('\n');
  const started = Date.now();
  const { stats } = formatFileDiff('big.ts', before, after);
  assert.ok(Date.now() - started < 2000, 'two versions with nothing in common must not blow up');
  assert.equal(stats.added, 3000);
  assert.equal(stats.removed, 3000);
});
