// ── engine integration: light mode ────────────────────────────────────────────
//
// Light mode is entirely about what goes *out* on the wire, so it is asserted
// there rather than through internal state. The fake provider records every
// request, which makes "which tools does the model actually see" a direct
// question instead of an inference from the config.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Session } from '../session.js';
import { buildSystemPrompt } from '../agent-factory.js';
import { startFakeProvider } from '../testing/fake-provider.js';
import type { FakeProvider } from '../testing/fake-provider.js';
import type { ClientInterface, EngineConfig } from '../index.js';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'marshall-light-'));
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
      // A fast tier is what turns the `context` tool on, so light mode has
      // something to actually suppress.
      models: {
        deep: { provider: 'llamacpp', host: fake.host, model: 'test-model' },
        fast: { provider: 'llamacpp', host: fake.host, model: 'small-model' },
      },
      ...extra,
    },
    silentClient,
  );
}

/** The system prompt as the model received it. */
function systemPrompt(fake: FakeProvider, index = 0): string {
  const message = fake.requests[index].messages.find(m => m.role === 'system');
  return String(message?.content ?? '');
}

test('light mode drops the scratchpad, job and sub-agent tools', async (t) => {
  const root = tempRoot();
  const fake = await startFakeProvider({ text: 'ok' }, { text: 'ok' });
  t.after(() => fake.close());

  const full = makeSession(root, fake);
  await full.run('anything');
  full.dispose();

  const light = makeSession(root, fake, { light: true });
  await light.run('anything');
  light.dispose();

  const [heavyTools, lightTools] = [fake.requests[0].tools, fake.requests[1].tools];

  // What has to survive: light mode is lean, not crippled.
  for (const kept of ['read_file', 'list_dir', 'search', 'write_file', 'edit_file', 'run_shell']) {
    assert.ok(lightTools.includes(kept), `light mode must keep ${kept}, got ${lightTools.join(', ')}`);
  }

  // What has to go.
  for (const dropped of [
    'note_write', 'note_read', 'note_list', 'log_append', 'log_read',
    'shell_output', 'shell_kill', 'shell_list',
    'context',
  ]) {
    assert.ok(heavyTools.includes(dropped),
      `precondition: the full belt should offer ${dropped}, got ${heavyTools.join(', ')}`);
    assert.ok(!lightTools.includes(dropped),
      `light mode must drop ${dropped}, got ${lightTools.join(', ')}`);
  }

  assert.ok(lightTools.length < heavyTools.length);
});

test('light mode takes run_shell\'s background option with it', async (t) => {
  const root = tempRoot();
  const fake = await startFakeProvider({ text: 'ok' }, { text: 'ok' });
  t.after(() => fake.close());

  const full = makeSession(root, fake);
  await full.run('anything');
  full.dispose();

  const light = makeSession(root, fake, { light: true });
  await light.run('anything');
  light.dispose();

  const shellSchema = (index: number) => {
    const tools = (fake.requests[index].body as any).tools as any[];
    return tools.find(t => t.function.name === 'run_shell').function.parameters;
  };

  assert.ok(shellSchema(0).properties.background,
    'precondition: the full belt offers backgrounding');
  assert.ok(!shellSchema(1).properties.background,
    'a job registry the session withholds is what removes the option from the schema');
});

test('the prompt never describes a tool the turn does not have', async (t) => {
  const root = tempRoot();
  const fake = await startFakeProvider({ text: 'ok' }, { text: 'ok' });
  t.after(() => fake.close());

  const full = makeSession(root, fake);
  await full.run('anything');
  full.dispose();

  const light = makeSession(root, fake, { light: true });
  await light.run('anything');
  light.dispose();

  // This is the failure light mode would otherwise introduce: rules telling a
  // model to use a scratchpad and background jobs it has no tools for.
  assert.match(systemPrompt(fake, 0), /note_write/, 'precondition: the full prompt teaches the scratchpad');
  assert.doesNotMatch(systemPrompt(fake, 1), /note_write|log_append/);
  assert.doesNotMatch(systemPrompt(fake, 1), /[Bb]ackground/);

  // And the rules that always apply are still there.
  assert.match(systemPrompt(fake, 1), /Always read_file before writing/);
  assert.match(systemPrompt(fake, 1), /single short sentence/);
});

test('light mode is a worthwhile saving, not a rounding error', async (t) => {
  const root = tempRoot();
  const fake = await startFakeProvider({ text: 'ok' }, { text: 'ok' });
  t.after(() => fake.close());

  const full = makeSession(root, fake);
  await full.run('anything');
  full.dispose();

  const light = makeSession(root, fake, { light: true });
  await light.run('anything');
  light.dispose();

  /** Everything fixed the model is sent before the task: prompt + tool schemas. */
  const overhead = (index: number) => {
    const body = fake.requests[index].body as any;
    return JSON.stringify(body.tools ?? []).length + systemPrompt(fake, index).length;
  };

  const saved = overhead(0) - overhead(1);
  // ~4 chars per token. The point of light mode is a quarter of a small model's
  // context window, so guard the order of magnitude — a change that quietly
  // reduced this to a few dozen tokens would mean the feature stopped working.
  assert.ok(saved / 4 > 700,
    `light mode should save well over 700 tokens of fixed overhead, saved ~${Math.round(saved / 4)}`);
});

test('setLight toggles the belt for the next turn', async (t) => {
  const root = tempRoot();
  const fake = await startFakeProvider({ text: 'ok' }, { text: 'ok' });
  t.after(() => fake.close());

  const session = makeSession(root, fake);
  t.after(() => session.dispose());

  assert.equal(session.light, false);
  await session.run('first');

  session.setLight(true);
  assert.equal(session.light, true);
  await session.run('second');

  assert.ok(fake.requests[0].tools.includes('note_write'));
  assert.ok(!fake.requests[1].tools.includes('note_write'),
    'the toggle takes effect on the turn after it, without rebuilding the session');
});

test('buildSystemPrompt keeps the rule order stable', () => {
  // The rules are read top to bottom by the model; a builder that reordered
  // them would be a silent behaviour change rather than a visible one.
  const heavy = buildSystemPrompt({ scratch: true, background: true });
  const order = ['read_file', 'edit_file', 'note_write', 'background', 'poll', 'short sentence'];
  let cursor = -1;
  for (const fragment of order) {
    const at = heavy.indexOf(fragment);
    assert.ok(at > cursor, `${fragment} is out of order in the prompt`);
    cursor = at;
  }
});
