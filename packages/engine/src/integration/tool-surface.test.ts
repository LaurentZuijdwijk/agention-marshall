// ── engine integration: what the model is actually offered ───────────────────
//
// `toolAllowlist` and `maskToolResults` both change the belt, and both are
// public `EngineConfig` surface. Asserted on the wire for the same reason light
// mode is: "which tools does the model see" is a direct question of the request
// the provider received, not an inference from the config that produced it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Session } from '../session.js';
import { startFakeProvider } from '../testing/fake-provider.js';
import type { FakeProvider } from '../testing/fake-provider.js';
import type { ClientInterface, EngineConfig } from '../index.js';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'marshall-surface-'));
}

const silentClient: ClientInterface = {
  onOutput: () => {},
  requestApproval: async () => 'approve',
};

function makeSession(root: string, fake: FakeProvider, extra: Partial<EngineConfig> = {}): Session {
  return new Session(
    {
      agent: { provider: 'llamacpp', host: fake.host, model: 'test-model' },
      workspaceRoot: root,
      compressionThreshold: 0,
      enableWebSearch: false,
      models: {
        deep: { provider: 'llamacpp', host: fake.host, model: 'test-model' },
        fast: { provider: 'llamacpp', host: fake.host, model: 'small-model' },
      },
      ...extra,
    },
    silentClient,
  );
}

test('masking is on by default, and retrieve_tool_result comes with it', async (t) => {
  const root = tempRoot();
  const fake = await startFakeProvider({ text: 'ok' });
  t.after(() => fake.close());
  const session = makeSession(root, fake);
  t.after(() => session.dispose());

  await session.run('anything');
  assert.ok(fake.requests[0].tools.includes('retrieve_tool_result'),
    'the way back to a masked result has to be on the belt that masks');
});

// Masking trades context for recall. Turning it off is only coherent if the
// tool that exists to undo it goes too — otherwise the model carries a tool
// on every request that can only ever return what it can already see.
test('maskToolResults: false drops retrieve_tool_result from the belt', async (t) => {
  const root = tempRoot();
  const fake = await startFakeProvider({ text: 'ok' });
  t.after(() => fake.close());
  const session = makeSession(root, fake, { maskToolResults: false });
  t.after(() => session.dispose());

  await session.run('anything');
  assert.equal(fake.requests[0].tools.includes('retrieve_tool_result'), false);
  assert.ok(fake.requests[0].tools.includes('read_file'), 'and the rest of the belt is untouched');
});

test('toolAllowlist offers only what it names', async (t) => {
  const root = tempRoot();
  const fake = await startFakeProvider({ text: 'ok' });
  t.after(() => fake.close());
  const session = makeSession(root, fake, { toolAllowlist: ['run_shell', 'edit_file'] });
  t.after(() => session.dispose());

  await session.run('anything');
  assert.deepEqual([...fake.requests[0].tools].sort(), ['edit_file', 'run_shell']);
});

// The claim this defends is made in session.ts's turn prompt: a rule can never
// describe a tool this turn does not have. Every guidance block keys off
// whether its tool resolved — but the allowlist ran *after* that list was
// built, so a belt trimmed to the shell still carried paragraphs about the
// context and planner tools it had just lost.
test('guidance never describes a tool the allowlist removed', async (t) => {
  const root = tempRoot();
  const fake = await startFakeProvider({ text: 'ok' });
  t.after(() => fake.close());
  const session = makeSession(root, fake, { toolAllowlist: ['run_shell'] });
  t.after(() => session.dispose());

  await session.run('anything');
  const prompt = String(fake.requests[0].messages.find(m => m.role === 'system')?.content ?? '');

  for (const absent of ['context', 'planner', 'reviewer', 'ask_user']) {
    assert.equal(fake.requests[0].tools.includes(absent), false, `precondition: ${absent} is gone`);
  }
  assert.doesNotMatch(prompt, /\bcontext\b tool|Prefer the `context` tool/,
    'the context guidance survived its tool');
  assert.doesNotMatch(prompt, /`planner`|`reviewer`/,
    'planner/reviewer guidance survived their tools');
});

// ~284 tokens of schema on every request, for tools that across 107 benchmark
// runs and 4,012 tool calls were never invoked once — because a repository is
// almost never mid-merge. The belt is rebuilt per turn, so this is a per-turn
// question rather than a fixed cost.
test('conflict tools are absent until a merge is actually in progress', async (t) => {
  const root = tempRoot();
  const fake = await startFakeProvider({ text: 'ok' });
  t.after(() => fake.close());
  const session = makeSession(root, fake);
  t.after(() => session.dispose());

  await session.run('anything');
  const tools = fake.requests[0].tools;
  assert.equal(tools.includes('list_conflicts'), false);
  assert.equal(tools.includes('resolve_conflicts'), false);
  assert.ok(tools.includes('edit_file'), 'the rest of the belt is untouched');
});

test('a merge in progress brings them back', async (t) => {
  const root = tempRoot();
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.git', 'MERGE_HEAD'), 'deadbeef\n');
  const fake = await startFakeProvider({ text: 'ok' });
  t.after(() => fake.close());
  const session = makeSession(root, fake);
  t.after(() => session.dispose());

  await session.run('anything');
  assert.ok(fake.requests[0].tools.includes('list_conflicts'));
  assert.ok(fake.requests[0].tools.includes('resolve_conflicts'));
});

// The writers are how the scratch area comes to exist, so they are always
// offered; the readers can only report "nothing there" until it does.
test('scratch readers wait until there is something to read', async (t) => {
  const root = tempRoot();
  const fake = await startFakeProvider({ text: 'ok' });
  t.after(() => fake.close());
  const session = makeSession(root, fake);
  t.after(() => session.dispose());

  await session.run('anything');
  const tools = fake.requests[0].tools;
  assert.ok(tools.includes('note_write'), 'the writer that creates the area stays');
  assert.ok(tools.includes('log_append'));
  for (const reader of ['note_read', 'note_list', 'log_read']) {
    assert.equal(tools.includes(reader), false, `${reader} has nothing to read yet`);
  }
});

test('once a note exists, the readers are offered', async (t) => {
  const root = tempRoot();
  mkdirSync(join(root, '.marshall', 'notes'), { recursive: true });
  const fake = await startFakeProvider({ text: 'ok' });
  t.after(() => fake.close());
  const session = makeSession(root, fake);
  t.after(() => session.dispose());

  await session.run('anything');
  for (const reader of ['note_read', 'note_list', 'log_read']) {
    assert.ok(fake.requests[0].tools.includes(reader), `${reader} should be back`);
  }
});

// The belt is rebuilt every turn, so the check has to be a per-turn question
// rather than a per-session one: a merge can start at any point in a long
// session — the agent itself may run `git merge` through run_shell — and the
// tools have to appear for the turn that needs them, in the session that is
// already running.
test('a merge starting mid-session brings the conflict tools back on the next turn', async (t) => {
  const root = tempRoot();
  const fake = await startFakeProvider({ text: 'ok' }, { text: 'ok' });
  t.after(() => fake.close());
  const session = makeSession(root, fake);
  t.after(() => session.dispose());

  await session.run('first turn, no merge');
  assert.equal(fake.requests[0].tools.includes('resolve_conflicts'), false,
    'precondition: nothing to resolve yet');

  // What `git merge` leaves behind when it stops on a conflict — written here
  // directly so the test does not depend on git being installed.
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.git', 'MERGE_HEAD'), 'deadbeef\n');

  await session.run('second turn, mid-merge');
  assert.ok(fake.requests[1].tools.includes('resolve_conflicts'),
    'the same session must pick the tools up without being restarted');
  assert.ok(fake.requests[1].tools.includes('list_conflicts'));
});

test('and they go away again once the merge is resolved', async (t) => {
  const root = tempRoot();
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.git', 'MERGE_HEAD'), 'deadbeef\n');
  const fake = await startFakeProvider({ text: 'ok' }, { text: 'ok' });
  t.after(() => fake.close());
  const session = makeSession(root, fake);
  t.after(() => session.dispose());

  await session.run('mid-merge');
  assert.ok(fake.requests[0].tools.includes('resolve_conflicts'), 'precondition');

  rmSync(join(root, '.git', 'MERGE_HEAD'));  // what a completed merge commit does

  await session.run('after resolving');
  assert.equal(fake.requests[1].tools.includes('resolve_conflicts'), false);
});
