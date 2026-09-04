import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createScratchTools } from './scratch-tools.js';
import { createKeyedLock } from '../primitives/keyed-lock.js';
import type { ToolConfig } from '../types.js';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'marshall-scratch-test-'));
}

function makeTools(
  root: string,
  fileLock?: ToolConfig['fileLock'],
): Record<string, ReturnType<typeof createScratchTools>[number]> {
  const config: ToolConfig = { workspaceRoot: root, approval: async () => 'approve', fileLock };
  return Object.fromEntries(createScratchTools(config).map((t) => [t.name, t]));
}

test('note_write creates a markdown note under .marshall/notes/', async () => {
  const root = tempRoot();
  const tools = makeTools(root);
  const result = await tools.note_write.execute('a', 'b', { name: 'plan', content: '# Plan\nhello' }, 'id');
  assert.match(result, /saved/);
  const file = join(root, '.marshall', 'notes', 'plan.md');
  assert.ok(existsSync(file), 'note file should exist');
  assert.equal(readFileSync(file, 'utf8'), '# Plan\nhello');
});

test('note_read returns the note content', async () => {
  const root = tempRoot();
  const tools = makeTools(root);
  await tools.note_write.execute('a', 'b', { name: 'findings', content: 'the findings' }, 'id');
  const result = await tools.note_read.execute('a', 'b', { name: 'findings' }, 'id');
  assert.match(result, /the findings/);
});

test('note_read reports a missing note', async () => {
  const root = tempRoot();
  const tools = makeTools(root);
  const result = await tools.note_read.execute('a', 'b', { name: 'nope' }, 'id');
  assert.match(result, /not found/);
});

test('note_list lists created notes', async () => {
  const root = tempRoot();
  const tools = makeTools(root);
  await tools.note_write.execute('a', 'b', { name: 'alpha', content: 'x' }, 'id');
  await tools.note_write.execute('a', 'b', { name: 'beta', content: 'y' }, 'id');
  const result = await tools.note_list.execute('a', 'b', {}, 'id');
  assert.match(result, /alpha/);
  assert.match(result, /beta/);
});

test('note_list reports when empty', async () => {
  const root = tempRoot();
  const tools = makeTools(root);
  const result = await tools.note_list.execute('a', 'b', {}, 'id');
  assert.match(result, /no notes/);
});

test('note names are sanitised to prevent path escape', async () => {
  const root = tempRoot();
  const tools = makeTools(root);
  await tools.note_write.execute('a', 'b', { name: '../evil', content: 'x' }, 'id');
  // '../evil' -> '/'→'_' -> '.._evil' -> '..'(2+ dots)→'_' -> '__evil'
  const file = join(root, '.marshall', 'notes', '__evil.md');
  assert.ok(existsSync(file), 'sanitised note should be written inside notes dir');
  assert.ok(!existsSync(join(root, '.marshall', 'notes', '..', 'evil.md')), 'should not escape notes dir');
});

test('log_append writes a timestamped entry to session.log', async () => {
  const root = tempRoot();
  const tools = makeTools(root);
  const result = await tools.log_append.execute('a', 'b', { message: 'a log line' }, 'id');
  assert.match(result, /Logged at/);
  const log = join(root, '.marshall', 'session.log');
  assert.ok(existsSync(log), 'session.log should exist');
  const content = readFileSync(log, 'utf8');
  assert.match(content, /a log line/);
  assert.match(content, /##/);
});

test('log_append appends rather than overwrites', async () => {
  const root = tempRoot();
  const tools = makeTools(root);
  await tools.log_append.execute('a', 'b', { message: 'first' }, 'id');
  await tools.log_append.execute('a', 'b', { message: 'second' }, 'id');
  const content = readFileSync(join(root, '.marshall', 'session.log'), 'utf8');
  assert.match(content, /first/);
  assert.match(content, /second/);
});

test('log_read returns the full log', async () => {
  const root = tempRoot();
  const tools = makeTools(root);
  await tools.log_append.execute('a', 'b', { message: 'line one' }, 'id');
  await tools.log_append.execute('a', 'b', { message: 'line two' }, 'id');
  const result = await tools.log_read.execute('a', 'b', {}, 'id');
  assert.match(result, /line one/);
  assert.match(result, /line two/);
});

test('log_read can return only the tail', async () => {
  const root = tempRoot();
  const tools = makeTools(root);
  await tools.log_append.execute('a', 'b', { message: 'aaa' }, 'id');
  await tools.log_append.execute('a', 'b', { message: 'bbb' }, 'id');
  const result = await tools.log_read.execute('a', 'b', { tail: 2 }, 'id');
  assert.doesNotMatch(result, /aaa/);
  assert.match(result, /bbb/);
});

test('log_read reports when no log exists', async () => {
  const root = tempRoot();
  const tools = makeTools(root);
  const result = await tools.log_read.execute('a', 'b', {}, 'id');
  assert.match(result, /no session log/);
});

test('scratch tools bypass approval entirely', async () => {
  let consulted = false;
  const root = tempRoot();
  const config: ToolConfig = { workspaceRoot: root, approval: async () => { consulted = true; return 'approve'; } };
  const tools = Object.fromEntries(createScratchTools(config).map((t) => [t.name, t]));
  await tools.note_write.execute('a', 'b', { name: 'n', content: 'x' }, 'id');
  assert.equal(consulted, false, 'scratch tools must not require approval');
});

test('concurrent log_append calls preserve every entry', async () => {
  const root = tempRoot();
  const tools = makeTools(root);
  await Promise.all(Array.from({ length: 20 }, (_, i) =>
    tools.log_append.execute('a', 'b', { message: `entry-${i}` }, `id-${i}`),
  ));
  const content = readFileSync(join(root, '.marshall', 'session.log'), 'utf8');
  for (let i = 0; i < 20; i++) assert.match(content, new RegExp(`entry-${i}`));
});

// Every background agent gets its own belt. A lock owned by the factory would
// make each belt take a private one and serialise against nothing, which is
// exactly the case the session's shared lock exists for — the append is a
// read-modify-write, so two unsynchronised writers drop each other's entries.
test('two belts sharing the session lock do not lose each other’s entries', async () => {
  const root = tempRoot();
  const fileLock = createKeyedLock();
  const first = makeTools(root, fileLock);
  const second = makeTools(root, fileLock);

  await Promise.all(Array.from({ length: 20 }, (_, i) =>
    (i % 2 ? second : first).log_append.execute('a', 'b', { message: `entry-${i}` }, `id-${i}`),
  ));

  const content = readFileSync(join(root, '.marshall', 'session.log'), 'utf8');
  for (let i = 0; i < 20; i++) assert.match(content, new RegExp(`entry-${i}`));
});
