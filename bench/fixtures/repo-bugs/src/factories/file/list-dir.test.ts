import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createReadOnlyFileTools } from './index.js';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'marshall-listdir-test-'));
}

test('list_dir lists prefixed entries', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'f.txt'), '');
  mkdirSync(join(root, 'dir'));
  const [, list_dir] = createReadOnlyFileTools(root);
  const result = await list_dir.execute('a', 'b', { path: '.' }, 'id');
  const asLines = result.split('\n');
  assert.ok(asLines.some((l) => l.startsWith('f') && l.includes('f.txt')));
  assert.ok(asLines.some((l) => l.startsWith('d') && l.includes('dir')));
});

// The gap this closes: a model choosing between read_file and search for a
// large single-line file (a minified bundle, say) had no way to see the size
// coming — it had to call read_file first to find out. Seeing "f  480020
// bundle.min.js" before ever reading it is what lets a model prefer search
// for a file it can tell in advance is not meant to be read whole.
test('list_dir shows each file its size in bytes', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'small.txt'), 'hello');
  writeFileSync(join(root, 'big.txt'), 'x'.repeat(480_020));
  const [, list_dir] = createReadOnlyFileTools(root);
  const result = await list_dir.execute('a', 'b', { path: '.' }, 'id');

  assert.match(result, /f\s+5\s+small\.txt/);
  assert.match(result, /f\s+480020\s+big\.txt/);
});

test('list_dir does not show a size for directories', async () => {
  const root = tempRoot();
  mkdirSync(join(root, 'subdir'));
  const [, list_dir] = createReadOnlyFileTools(root);
  const result = await list_dir.execute('a', 'b', { path: '.' }, 'id');

  assert.match(result, /^d\s+subdir$/m, 'no stray digits where a directory has no size');
});

// A stat() failure on one entry — a broken symlink, or a file removed between
// readdir and stat — must not fail the whole listing. A dangling symlink is
// the reproducible version of that race: readdir reports it (it exists as a
// link), but stat() follows it and finds nothing.
test('an entry whose stat() fails still appears, with no size rather than a crash', async () => {
  const root = tempRoot();
  symlinkSync(join(root, 'does-not-exist'), join(root, 'broken-link'));
  writeFileSync(join(root, 'stays.txt'), 'y');
  const [, list_dir] = createReadOnlyFileTools(root);

  const result = await list_dir.execute('a', 'b', { path: '.' }, 'id');

  assert.doesNotMatch(result, /^Error:/);
  assert.match(result, /stays\.txt/);
  assert.match(result, /broken-link/, 'the entry is still listed, by name, even though its size is unknown');
});

test('list_dir lists a batch of directories in one call, each under its own header', async () => {
  const root = tempRoot();
  mkdirSync(join(root, 'a'));
  mkdirSync(join(root, 'b'));
  writeFileSync(join(root, 'a', 'one.txt'), '');
  writeFileSync(join(root, 'b', 'two.txt'), '');
  const [, list_dir] = createReadOnlyFileTools(root);

  const result = await list_dir.execute('a', 'b', { paths: ['a', 'b'] }, 'id');

  assert.match(result, /^a:/m);
  assert.match(result, /one\.txt/);
  assert.match(result, /^b:/m);
  assert.match(result, /two\.txt/);
});

test('a single-element paths[] batch reads exactly like the legacy single-path call', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'f.txt'), '');
  const [, list_dir] = createReadOnlyFileTools(root);

  const legacy = await list_dir.execute('a', 'b', { path: '.' }, 'id');
  const batch = await list_dir.execute('a', 'b', { paths: ['.'] }, 'id');

  assert.equal(batch, legacy, 'one-item batches must not gain a header the legacy call never had');
});

test('list_dir accepts paths sent as a JSON string', async () => {
  const root = tempRoot();
  mkdirSync(join(root, 'a'));
  mkdirSync(join(root, 'b'));
  const [, list_dir] = createReadOnlyFileTools(root);

  const result = await list_dir.execute('a', 'b', { paths: JSON.stringify(['a', 'b']) }, 'id');

  assert.match(result, /^a:/m);
  assert.match(result, /^b:/m);
});

test('list_dir with no arguments still lists the workspace root', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'f.txt'), '');
  const [, list_dir] = createReadOnlyFileTools(root);

  const result = await list_dir.execute('a', 'b', {}, 'id');
  assert.match(result, /f\.txt/);
});

// list_dir had no cap of any kind before batching; a directory with thousands
// of entries returned a line for each. Batching would have multiplied that.
test('a huge directory is capped, and says how much it withheld', async () => {
  const root = tempRoot();
  mkdirSync(join(root, 'many'));
  for (let i = 0; i < 620; i++) writeFileSync(join(root, 'many', `f${String(i).padStart(4, '0')}.txt`), '');
  const [, list_dir] = createReadOnlyFileTools(root);

  const result = await list_dir.execute('a', 'b', { paths: ['many'] }, 'id');
  const listed = result.split('\n').filter(l => /^[fd] /.test(l)).length;

  assert.equal(listed, 500, 'the per-directory cap holds');
  assert.match(result, /120 more entries not shown/, 'and a truncated listing never looks complete');
});

// The budget is spent down rather than used to skip: a later directory gets
// whatever is left and truncates within it, so every requested path still
// appears. Only a path reached with nothing left at all is skipped outright.
test('a batch cannot spend more than the whole-call entry budget', async () => {
  const root = tempRoot();
  for (const d of ['a', 'b', 'c']) {
    mkdirSync(join(root, d));
    for (let i = 0; i < 480; i++) writeFileSync(join(root, d, `f${String(i).padStart(4, '0')}.txt`), '');
  }
  const [, list_dir] = createReadOnlyFileTools(root);

  const result = await list_dir.execute('a', 'b', { paths: ['a', 'b', 'c'] }, 'id');
  const listed = result.split('\n').filter(l => /^[fd] /.test(l)).length;

  assert.equal(listed, 1000, 'the batch spends its budget and not a row more');
  for (const d of ['a', 'b', 'c']) {
    assert.match(result, new RegExp(`^${d}:`, 'm'), `${d} still appears rather than being dropped`);
  }
  assert.match(result, /more entries not shown/, 'and the directory that ran out of budget says so');
});

test('a path reached with no budget left is skipped, and named as skipped', async () => {
  const root = tempRoot();
  for (const d of ['big1', 'big2', 'tail']) mkdirSync(join(root, d));
  for (const d of ['big1', 'big2']) {
    for (let i = 0; i < 500; i++) writeFileSync(join(root, d, `f${String(i).padStart(4, '0')}.txt`), '');
  }
  writeFileSync(join(root, 'tail', 'never-reached.txt'), '');
  const [, list_dir] = createReadOnlyFileTools(root);

  const result = await list_dir.execute('a', 'b', { paths: ['big1', 'big2', 'tail'] }, 'id');

  assert.match(result, /entry budget of 1000 reached/);
  assert.doesNotMatch(result, /never-reached\.txt/, 'the skipped directory is genuinely not listed');
});
