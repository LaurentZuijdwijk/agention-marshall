import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createReadOnlyFileTools } from './index.js';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'marshall-search-test-'));
}

test('search finds matches with file:line: content', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'x.txt'), 'alpha\nbeta\nalpha again\n');
  const [, , search] = createReadOnlyFileTools(root);
  const result = await search.execute('a', 'b', { pattern: 'alpha' }, 'id');
  assert.match(result, /x\.txt:1: alpha/);
  assert.match(result, /x\.txt:3: alpha again/);
});

// The skip list names generated *directories*. A plain file that happens to be
// called `build` or `vendor` is an ordinary file, and skipping it searched
// nothing while reporting nothing.
test('search reads a file whose name matches a skipped directory', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'build'), 'needle in a file named build\n');
  writeFileSync(join(root, 'vendor'), 'needle in a file named vendor\n');
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'dist', 'generated.js'), 'needle that should stay skipped\n');

  const [, , search] = createReadOnlyFileTools(root);
  const result = await search.execute('a', 'b', { pattern: 'needle' }, 'id');

  assert.match(result, /build:1:/);
  assert.match(result, /vendor:1:/);
  assert.doesNotMatch(result, /dist/, 'the directory of the same name is still skipped');
});

test('search supports fileGlob filtering', async () => {
  const root = tempRoot();
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'keep.ts'), 'needle\n');
  writeFileSync(join(root, 'skip.md'), 'needle\n');
  writeFileSync(join(root, 'src', 'nested.ts'), 'needle\n');
  const [, , search] = createReadOnlyFileTools(root);
  const result = await search.execute('a', 'b', { pattern: 'needle', fileGlob: '.ts' }, 'id');
  assert.match(result, /keep\.ts:1: needle/);
  assert.match(result, /src[\\/]nested\.ts:1: needle/);
  assert.doesNotMatch(result, /skip\.md/);
});

test('search accepts shell-style fileGlob patterns', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'keep.ts'), 'needle\n');
  writeFileSync(join(root, 'skip.js'), 'needle\n');
  const [, , search] = createReadOnlyFileTools(root);
  const result = await search.execute('a', 'b', { pattern: 'needle', fileGlob: '*.ts' }, 'id');
  assert.match(result, /keep\.ts:1: needle/);
  assert.doesNotMatch(result, /skip\.js/);
});

test('plain-name searches ignore case and identifier separators', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'names.txt'), 'file-tools\nfile_tools\nfileTools\nFile Tools\n');
  const [, , search] = createReadOnlyFileTools(root);
  const result = await search.execute('a', 'b', { pattern: 'file-tools' }, 'id');
  assert.equal(result.split('\n').length, 4);
});

test('search accepts a file path', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'target.txt'), 'needle\n');
  const [, , search] = createReadOnlyFileTools(root);
  const result = await search.execute('a', 'b', { pattern: 'needle', path: 'target.txt' }, 'id');
  assert.match(result, /target\.txt:1: needle/);
});

test('search reports no matches', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'x.txt'), 'nothing here\n');
  const [, , search] = createReadOnlyFileTools(root);
  const result = await search.execute('a', 'b', { pattern: 'zzz-not-present' }, 'id');
  assert.match(result, /No matches/);
  assert.match(result, /1 files searched/);
});

test('search reports invalid regexes clearly', async () => {
  const [, , search] = createReadOnlyFileTools(tempRoot());
  const result = await search.execute('a', 'b', { pattern: '[' }, 'id');
  assert.match(result, /^Error: Invalid regex:/);
});

test('search only reports truncation when the limit is reached', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'x.txt'), 'needle\n');
  const [, , search] = createReadOnlyFileTools(root, { maxSearchResults: 1 });
  const result = await search.execute('a', 'b', { pattern: 'needle' }, 'id');
  assert.doesNotMatch(result, /truncated/);
});

// ── what search reports, and what it must not invent ──────────────────────────
//
// The grep every agent and every read-only sub-agent reaches for. Its output
// goes straight into a model's context, so a wrong line is worse than a missing
// one: the model follows it.

test('search does not report the truncation notice as a line of the file', async () => {
  const root = tempRoot();
  // Bigger than the per-file search cap, so the read is cut short.
  writeFileSync(join(root, 'big.log'), 'x'.repeat(300 * 1024) + '\nneedle\n');
  const [, , search] = createReadOnlyFileTools(root);

  // Words that appear only in the truncation marker, never in the file.
  for (const pattern of ['truncated', 'exceeds', 'read limit']) {
    const result = await search.execute('a', 'b', { pattern }, 'id');
    assert.doesNotMatch(result, /^big\.log:\d+:/m,
      `"${pattern}" matched the marker and was reported as a line of big.log: ${result}`);
  }
});

test('search says when a file was only read up to the cap, matches or not', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'big.log'), 'x'.repeat(300 * 1024) + '\nneedle\n');
  writeFileSync(join(root, 'small.ts'), 'needle\n');
  const [, , search] = createReadOnlyFileTools(root);

  const hit = await search.execute('a', 'b', { pattern: 'needle' }, 'id');
  assert.match(hit, /small\.ts:1: needle/);
  assert.match(hit, /searched only the first 256 KiB of big\.log/);

  // The case that matters most: "no matches" in a partly-read file is a weaker
  // claim than "no matches", and a caller that cannot tell stops looking.
  const miss = await search.execute('a', 'b', { pattern: 'zzz-absent' }, 'id');
  assert.match(miss, /No matches found/);
  assert.match(miss, /searched only the first 256 KiB of big\.log/);
});

test('search skips binary files rather than spilling their bytes into the results', async () => {
  const root = tempRoot();
  // A NUL byte makes it binary; "limit" sits in there as decodable text.
  writeFileSync(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 0xff, 0x6c, 0x69, 0x6d, 0x69, 0x74]));
  writeFileSync(join(root, 'code.ts'), 'const limit = 5;\n');
  const [, , search] = createReadOnlyFileTools(root);

  const result = await search.execute('a', 'b', { pattern: 'limit' }, 'id');

  assert.match(result, /code\.ts:1: const limit = 5;/);
  assert.doesNotMatch(result, /logo\.png/, 'the binary must not appear as a match');
  assert.doesNotMatch(result, /[\u0000-\u0008\ufffd]/, 'no raw bytes in what the model is shown');
  assert.match(result, /skipped 1 binary file/);
});

// A "line" in a minified bundle is the whole file, so one hit used to return a
// quarter of a megabyte — with the match buried in the middle of it.
test('search clips a very long matched line around the match', async () => {
  const root = tempRoot();
  const filler = 'var a=1;'.repeat(30_000);
  writeFileSync(join(root, 'bundle.min.js'), `${filler}needle${filler}\n`);
  const [, , search] = createReadOnlyFileTools(root);

  const result = await search.execute('a', 'b', { pattern: 'needle' }, 'id');

  assert.ok(result.length < 1_000, `one hit should not be a context dump: got ${result.length} chars`);
  assert.match(result, /bundle\.min\.js:1:/);
  assert.match(result, /needle/, 'the part the caller asked for is what survives the clip');
  assert.match(result, /…/, 'and it is marked as clipped');
});

// "No matches found" and "your filter excluded everything" call for opposite
// next steps, and a fileGlob carrying a path fragment — `src/*.ts`, the obvious
// thing to try — used to produce the first while meaning the second.
test('a fileGlob that matches no files says so instead of reporting no matches', async () => {
  const root = tempRoot();
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.ts'), 'needle\n');
  const [, , search] = createReadOnlyFileTools(root);

  const excluded = await search.execute('a', 'b', { pattern: 'needle', fileGlob: 'src/*.ts' }, 'id');
  assert.match(excluded, /No files matched fileGlob/);
  assert.match(excluded, /file name only/, 'and it says why, since the glob looks reasonable');

  // The same pattern with a glob that does match is the control.
  const found = await search.execute('a', 'b', { pattern: 'needle', fileGlob: '*.ts' }, 'id');
  assert.match(found, /src[\\/]a\.ts:1: needle/);

  // A real miss must still read as a real miss.
  const miss = await search.execute('a', 'b', { pattern: 'zzz-absent', fileGlob: '*.ts' }, 'id');
  assert.match(miss, /No matches found/);
  assert.doesNotMatch(miss, /No files matched/);
});

test('search skips generated output directories', async () => {
  const root = tempRoot();
  for (const dir of ['target', 'out', 'vendor', '.gradle']) {
    mkdirSync(join(root, dir));
    writeFileSync(join(root, dir, 'generated.txt'), 'needle\n');
  }
  writeFileSync(join(root, 'src.ts'), 'needle\n');
  const [, , search] = createReadOnlyFileTools(root);

  const result = await search.execute('a', 'b', { pattern: 'needle' }, 'id');

  assert.match(result, /src\.ts:1: needle/);
  for (const dir of ['target', 'out', 'vendor', '.gradle']) {
    assert.doesNotMatch(result, new RegExp(dir.replace('.', '\\.')), `${dir} should not be walked`);
  }
});
