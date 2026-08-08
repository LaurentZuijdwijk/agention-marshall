import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileTools, createReadOnlyFileTools } from './file-tools.js';
import type { ToolConfig } from '../types.js';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'marshall-file-test-'));
}

function makeConfig(overrides: Partial<ToolConfig> = {}): ToolConfig {
  return {
    workspaceRoot: tempRoot(),
    approval: async () => 'approve',
    ...overrides,
  };
}

test('read_file returns content with a header and numbered lines', async () => {
  const root = tempRoot();
  const file = join(root, 'a.txt');
  writeFileSync(file, 'line one\nline two\nline three\n');
  const [read_file] = createReadOnlyFileTools(root);
  const result = await read_file.execute('a', 'b', { path: 'a.txt' }, 'id');
  assert.match(result, /a\.txt/);
  assert.match(result, /1 \| line one/);
  assert.match(result, /3 \| line three/);
});

test('read_file honours startLine/endLine', async () => {
  const root = tempRoot();
  const file = join(root, 'a.txt');
  writeFileSync(file, 'one\ntwo\nthree\n');
  const [read_file] = createReadOnlyFileTools(root);
  const result = await read_file.execute('a', 'b', { path: 'a.txt', startLine: 2, endLine: 2 }, 'id');
  assert.match(result, /2 \| two/);
  assert.doesNotMatch(result, /one/);
  assert.doesNotMatch(result, /three/);
});

test('read_file blocks path escape', async () => {
  const root = tempRoot();
  const [read_file] = createReadOnlyFileTools(root);
  const result = await read_file.execute('a', 'b', { path: '../../etc/passwd' }, 'id');
  assert.match(result, /^Error:/);
});

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

test('search finds matches with file:line: content', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'x.txt'), 'alpha\nbeta\nalpha again\n');
  const [, , search] = createReadOnlyFileTools(root);
  const result = await search.execute('a', 'b', { pattern: 'alpha' }, 'id');
  assert.match(result, /x\.txt:1: alpha/);
  assert.match(result, /x\.txt:3: alpha again/);
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

test('write_file creates a new file (no read required)', async () => {
  const root = tempRoot();
  const tools = createFileTools(makeConfig({ workspaceRoot: root }));
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const result = await byName.write_file.execute('a', 'b', { path: 'new.txt', content: 'hello' }, 'id');
  assert.match(result, /Wrote 5 bytes/);
  assert.equal(readFileSync(join(root, 'new.txt'), 'utf8'), 'hello');
});

test('write_file refuses to overwrite a file not read this session', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'existing.txt'), 'original');
  const tools = createFileTools(makeConfig({ workspaceRoot: root }));
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const result = await byName.write_file.execute('a', 'b', { path: 'existing.txt', content: 'new' }, 'id');
  assert.match(result, /has not been read this session/);
  assert.equal(readFileSync(join(root, 'existing.txt'), 'utf8'), 'original');
});

test('write_file allows overwrite after reading the file', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'existing.txt'), 'original');
  const tools = createFileTools(makeConfig({ workspaceRoot: root }));
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  await byName.read_file.execute('a', 'b', { path: 'existing.txt' }, 'id');
  const result = await byName.write_file.execute('a', 'b', { path: 'existing.txt', content: 'updated' }, 'id');
  assert.match(result, /Wrote/);
  assert.equal(readFileSync(join(root, 'existing.txt'), 'utf8'), 'updated');
});

test('edit_file requires a prior read', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'target.txt'), 'hello world');
  const tools = createFileTools(makeConfig({ workspaceRoot: root }));
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const result = await byName.edit_file.execute('a', 'b', { path: 'target.txt', oldString: 'world', newString: 'there' }, 'id');
  assert.match(result, /has not been read this session/);
});

// The belt is rebuilt every turn, so a factory-owned read set makes "read it
// first" silently mean "read it first *this turn*": read a file, let the turn
// end, and editing it in the next one fails with "has not been read this
// session" even though it was. `ToolConfig.readFiles` is what the session
// passes to make the tracking outlive one belt.
test('read tracking passed in survives a rebuilt belt, so a read carries into the next turn', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'target.txt'), 'hello world');
  const readFiles = new Map<string, string>();

  const turnOne = Object.fromEntries(
    createFileTools(makeConfig({ workspaceRoot: root, readFiles })).map((t) => [t.name, t]),
  );
  await turnOne.read_file.execute('a', 'b', { path: 'target.txt' }, 'id');

  const turnTwo = Object.fromEntries(
    createFileTools(makeConfig({ workspaceRoot: root, readFiles })).map((t) => [t.name, t]),
  );
  const result = await turnTwo.edit_file.execute('a', 'b', { path: 'target.txt', oldString: 'world', newString: 'there' }, 'id');

  assert.match(result, /Edited/);
  assert.equal(readFileSync(join(root, 'target.txt'), 'utf8'), 'hello there');
});

test('without a shared set each belt tracks its own reads', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'target.txt'), 'hello world');

  const turnOne = Object.fromEntries(
    createFileTools(makeConfig({ workspaceRoot: root })).map((t) => [t.name, t]),
  );
  await turnOne.read_file.execute('a', 'b', { path: 'target.txt' }, 'id');

  const turnTwo = Object.fromEntries(
    createFileTools(makeConfig({ workspaceRoot: root })).map((t) => [t.name, t]),
  );
  const result = await turnTwo.edit_file.execute('a', 'b', { path: 'target.txt', oldString: 'world', newString: 'there' }, 'id');
  assert.match(result, /has not been read this session/);
});

// Models routinely emit several edit_file calls in one assistant message, and
// the SDK runs them concurrently. edit_file is a read-modify-write, so without
// serialisation both calls read the same original and the second write drops
// the first edit — while both still report "Edited".
test('parallel edits to one file all land', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'target.txt'), 'AAA\nBBB\nCCC\n');
  const tools = createFileTools(makeConfig({ workspaceRoot: root }));
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  await byName.read_file.execute('a', 'b', { path: 'target.txt' }, 'id');

  const results = await Promise.all([
    byName.edit_file.execute('a', 'b', { path: 'target.txt', oldString: 'AAA', newString: 'XXX' }, 'i1'),
    byName.edit_file.execute('a', 'b', { path: 'target.txt', oldString: 'BBB', newString: 'YYY' }, 'i2'),
    byName.edit_file.execute('a', 'b', { path: 'target.txt', oldString: 'CCC', newString: 'ZZZ' }, 'i3'),
  ]);

  for (const r of results) assert.match(r, /Edited/, `every edit reported success: ${results.join(' | ')}`);
  assert.equal(readFileSync(join(root, 'target.txt'), 'utf8'), 'XXX\nYYY\nZZZ\n');
});

// Serialising these is not enough on its own: each carries whole-file content
// built from the same read, so the second legitimately overwrites the first and
// the first's changes are simply gone — with both reporting success. The second
// has to be refused and told what to do instead.
test('two write_file calls for one path in a batch: the second is rejected, not silently applied', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'plan.md'), '# Plan\n');
  const tools = createFileTools(makeConfig({ workspaceRoot: root }));
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  await byName.read_file.execute('a', 'b', { path: 'plan.md' }, 'id');

  const [first, second] = await Promise.all([
    byName.write_file.execute('a', 'b', { path: 'plan.md', content: '# Plan\n\n- one\n' }, 'i1'),
    byName.write_file.execute('a', 'b', { path: 'plan.md', content: '# Plan\n\n- two\n' }, 'i2'),
  ]);

  assert.match(first, /Wrote/);
  assert.match(second, /changed after you read it/,
    `the second write must be refused, got: ${second}`);
  // And it must point the model at the tool that would have worked.
  assert.match(second, /edit_file/);
  assert.equal(readFileSync(join(root, 'plan.md'), 'utf8'), '# Plan\n\n- one\n',
    'the first write survives intact');
});

test('a rejected write leaves the file readable and re-writable after a fresh read', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'plan.md'), '# Plan\n');
  const tools = createFileTools(makeConfig({ workspaceRoot: root }));
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  await byName.read_file.execute('a', 'b', { path: 'plan.md' }, 'id');

  await Promise.all([
    byName.write_file.execute('a', 'b', { path: 'plan.md', content: 'one\n' }, 'i1'),
    byName.write_file.execute('a', 'b', { path: 'plan.md', content: 'two\n' }, 'i2'),
  ]);

  // Recovery is the whole point of rejecting rather than failing hard: re-read,
  // then the write goes through.
  await byName.read_file.execute('a', 'b', { path: 'plan.md' }, 'id');
  const retry = await byName.write_file.execute('a', 'b', { path: 'plan.md', content: 'reconciled\n' }, 'i3');
  assert.match(retry, /Wrote/);
  assert.equal(readFileSync(join(root, 'plan.md'), 'utf8'), 'reconciled\n');
});

test('an external change between read and write is refused too', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'notes.txt'), 'from the model\n');
  const tools = createFileTools(makeConfig({ workspaceRoot: root }));
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  await byName.read_file.execute('a', 'b', { path: 'notes.txt' }, 'id');

  // Someone edits the file in their editor while the turn is in flight.
  writeFileSync(join(root, 'notes.txt'), 'hand-edited by the user\n');

  const result = await byName.write_file.execute('a', 'b', { path: 'notes.txt', content: 'model version\n' }, 'i1');
  assert.match(result, /changed after you read it/);
  assert.equal(readFileSync(join(root, 'notes.txt'), 'utf8'), 'hand-edited by the user\n',
    "a user's own edit must not be clobbered by a write composed before it");
});

test('parallel write_file and edit_file on one file do not interleave', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'target.txt'), 'original\n');
  const tools = createFileTools(makeConfig({ workspaceRoot: root }));
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  await byName.read_file.execute('a', 'b', { path: 'target.txt' }, 'id');

  // The lock is taken in call order, so the write lands first and the edit then
  // reads *its* output rather than a stale original.
  const [wrote, edited] = await Promise.all([
    byName.write_file.execute('a', 'b', { path: 'target.txt', content: 'replaced\n' }, 'i1'),
    byName.edit_file.execute('a', 'b', { path: 'target.txt', oldString: 'original', newString: 'edited' }, 'i2'),
  ]);

  assert.match(wrote, /Wrote/);
  assert.match(edited, /not found/,
    'the edit ran after the overwrite, so "original" is gone — a stale read would have found it');
  assert.equal(readFileSync(join(root, 'target.txt'), 'utf8'), 'replaced\n');
});

test('edit_file replaces a unique occurrence', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'target.txt'), 'hello world\n');
  const tools = createFileTools(makeConfig({ workspaceRoot: root }));
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  await byName.read_file.execute('a', 'b', { path: 'target.txt' }, 'id');
  const result = await byName.edit_file.execute('a', 'b', { path: 'target.txt', oldString: 'world', newString: 'there' }, 'id');
  assert.match(result, /Edited/);
  assert.equal(readFileSync(join(root, 'target.txt'), 'utf8'), 'hello there\n');
});

test('edit_file rejects an oldString that is not found', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'target.txt'), 'hello\n');
  const tools = createFileTools(makeConfig({ workspaceRoot: root }));
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  await byName.read_file.execute('a', 'b', { path: 'target.txt' }, 'id');
  const result = await byName.edit_file.execute('a', 'b', { path: 'target.txt', oldString: 'nope', newString: 'x' }, 'id');
  assert.match(result, /oldString not found/);
});

test('edit_file rejects an ambiguous oldString that appears multiple times', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'target.txt'), 'dup\ndup\n');
  const tools = createFileTools(makeConfig({ workspaceRoot: root }));
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  await byName.read_file.execute('a', 'b', { path: 'target.txt' }, 'id');
  const result = await byName.edit_file.execute('a', 'b', { path: 'target.txt', oldString: 'dup', newString: 'x' }, 'id');
  assert.match(result, /appears 2 times/);
});

test('file tools go through the approval gate', async () => {
  const calls: string[] = [];
  const root = tempRoot();
  const tools = createFileTools({ workspaceRoot: root, approval: async (req) => { calls.push(req.toolName); return 'approve'; } });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  await byName.write_file.execute('a', 'b', { path: 'approved.txt', content: 'x' }, 'id');
  assert.ok(calls.includes('write_file'));
});

test('file tools are denied by approval', async () => {
  const root = tempRoot();
  const tools = createFileTools({ workspaceRoot: root, approval: async () => 'deny' });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const result = await byName.edit_file.execute('a', 'b', { path: 'x.txt', oldString: 'a', newString: 'b' }, 'id');
  assert.match(result, /denied/i);
});
