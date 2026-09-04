import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConflicts, applyResolution, hashConflict } from './conflicts.js';

const SIMPLE = [
  'line 1',
  '<<<<<<< HEAD',
  'ours line',
  '=======',
  'theirs line',
  '>>>>>>> feature-branch',
  'line 2',
].join('\n');

test('parseConflicts finds a single two-way hunk with labels and line numbers', () => {
  const hunks = parseConflicts(SIMPLE);
  assert.equal(hunks.length, 1);
  const [hunk] = hunks;
  assert.equal(hunk.startLine, 2);
  assert.equal(hunk.endLine, 6);
  assert.equal(hunk.oursLabel, 'HEAD');
  assert.equal(hunk.theirsLabel, 'feature-branch');
  assert.equal(hunk.oursText, 'ours line');
  assert.equal(hunk.theirsText, 'theirs line');
  assert.equal(hunk.baseText, undefined);
});

test('parseConflicts handles diff3-style markers with a base section', () => {
  const content = [
    '<<<<<<< HEAD',
    'ours line',
    '||||||| base',
    'base line',
    '=======',
    'theirs line',
    '>>>>>>> feature-branch',
  ].join('\n');
  const [hunk] = parseConflicts(content);
  assert.equal(hunk.baseText, 'base line');
  assert.equal(hunk.oursText, 'ours line');
  assert.equal(hunk.theirsText, 'theirs line');
});

test('parseConflicts finds multiple hunks in one file', () => {
  const content = [SIMPLE, 'line 3', SIMPLE].join('\n');
  const hunks = parseConflicts(content);
  assert.equal(hunks.length, 2);
  assert.notEqual(hunks[0].startLine, hunks[1].startLine);
});

test('parseConflicts returns nothing for a file with no markers', () => {
  assert.deepEqual(parseConflicts('just some normal text\nwith lines'), []);
});

test('parseConflicts stops cleanly on a truncated hunk missing its closer', () => {
  const content = ['<<<<<<< HEAD', 'ours line', '======='].join('\n');
  assert.deepEqual(parseConflicts(content), []);
});

test('applyResolution keeps ours', () => {
  const [hunk] = parseConflicts(SIMPLE);
  const result = applyResolution(SIMPLE, hunk, 'ours');
  assert.equal(result, ['line 1', 'ours line', 'line 2'].join('\n'));
});

test('applyResolution keeps theirs', () => {
  const [hunk] = parseConflicts(SIMPLE);
  const result = applyResolution(SIMPLE, hunk, 'theirs');
  assert.equal(result, ['line 1', 'theirs line', 'line 2'].join('\n'));
});

test('applyResolution keeps both, ours first', () => {
  const [hunk] = parseConflicts(SIMPLE);
  const result = applyResolution(SIMPLE, hunk, 'both');
  assert.equal(result, ['line 1', 'ours line', 'theirs line', 'line 2'].join('\n'));
});

test('applyResolution on a multi-hunk file only touches the targeted hunk', () => {
  const content = [SIMPLE, 'line 3', SIMPLE].join('\n');
  const hunks = parseConflicts(content);
  const result = applyResolution(content, hunks[0], 'ours');
  const remaining = parseConflicts(result);
  assert.equal(remaining.length, 1, 'the second hunk must still be intact');
});

test('hashConflict is stable for identical hunks and differs across content or path', () => {
  const [hunkA] = parseConflicts(SIMPLE);
  const [hunkB] = parseConflicts(SIMPLE);
  assert.equal(hashConflict('a.ts', hunkA), hashConflict('a.ts', hunkB));
  assert.notEqual(hashConflict('a.ts', hunkA), hashConflict('b.ts', hunkB));

  const other = [
    '<<<<<<< HEAD',
    'different ours',
    '=======',
    'theirs line',
    '>>>>>>> feature-branch',
  ].join('\n');
  const [hunkC] = parseConflicts(other);
  assert.notEqual(hashConflict('a.ts', hunkA), hashConflict('a.ts', hunkC));
});

test('hashConflict of one hunk is unaffected by resolving another hunk in the same file', () => {
  const content = [SIMPLE, 'line 3', SIMPLE].join('\n');
  const hunks = parseConflicts(content);
  const idBefore = hashConflict('f.ts', hunks[1]);
  const resolved = applyResolution(content, hunks[0], 'ours');
  const hunksAfter = parseConflicts(resolved);
  const idAfter = hashConflict('f.ts', hunksAfter[0]);
  assert.equal(idBefore, idAfter, 'content-based hash must survive an unrelated resolution shifting line numbers');
});
