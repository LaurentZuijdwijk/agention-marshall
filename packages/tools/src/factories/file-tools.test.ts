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
