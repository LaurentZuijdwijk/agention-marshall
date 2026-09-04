// ── engine integration: what the model is actually offered ───────────────────
//
// `toolAllowlist` and `maskToolResults` both change the belt, and both are
// public `EngineConfig` surface. Asserted on the wire for the same reason light
// mode is: "which tools does the model see" is a direct question of the request
// the provider received, not an inference from the config that produced it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
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
