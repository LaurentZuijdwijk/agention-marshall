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
