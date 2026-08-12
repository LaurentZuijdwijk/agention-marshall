// ── engine integration: spawned agents ────────────────────────────────────────
//
// Asserted on the wire for the same reason light-mode.test.ts is: "what does a
// spawned agent actually get" is a direct question there, and an inference from
// internal state anywhere else. The parent and its agents all talk to the same
// fake provider, so one recording holds both sides of the delegation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Session } from '../session.js';
import { startFakeProvider } from '../testing/fake-provider.js';
import type { FakeProvider } from '../testing/fake-provider.js';
import type { ClientInterface, EngineConfig, OutputEvent } from '../index.js';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'marshall-swarm-'));
}

function makeSession(
  root: string,
  fake: FakeProvider,
  extra: Partial<EngineConfig> = {},
  client?: ClientInterface,
): Session {
  return new Session(
    {
      agent: { provider: 'llamacpp', host: fake.host, model: 'test-model' },
      workspaceRoot: root,
      compressionThreshold: 0,
      enableWebSearch: false,
      swarm: true,
      // Off so a finished agent queues its report instead of starting a turn
      // to act on it — these tests are about the delegation, not the wake-up.
      autoResume: false,
      models: {
        deep: { provider: 'llamacpp', host: fake.host, model: 'deep-model' },
        fast: { provider: 'llamacpp', host: fake.host, model: 'fast-model' },
      },
      ...extra,
    },
    client ?? { onOutput: () => {}, requestApproval: async () => 'approve' },
  );
}

/** The request the spawned agent made, found by the model it runs on. */
function requestFor(fake: FakeProvider, model: string) {
  const found = fake.requests.find(r => (r.body as { model?: string }).model === model);
  assert.ok(found, `no request went to ${model}; saw ${fake.requests.map(r => (r.body as { model?: string }).model).join(', ')}`);
  return found;
}

/** Waits for every spawned agent to stop running. */
async function agentsSettled(session: Session): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (!session.agents.list().some(job => job.status === 'running')) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('spawned agents never settled');
}

const spawnCall = (args: Record<string, unknown>) => ({
  name: 'spawn_agent',
  arguments: { brief: 'restyle the header', tier: 'fast', toolset: 'edit', ...args },
});

test('the swarm tools are off unless asked for', async (t) => {
  const root = tempRoot();
  const fake = await startFakeProvider({ text: 'ok' }, { text: 'ok' });
  t.after(() => fake.close());

  const off = makeSession(root, fake, { swarm: false });
  await off.run('anything');
  off.dispose();

  const on = makeSession(root, fake);
  await on.run('anything');
  on.dispose();

  for (const name of ['spawn_agent', 'agent_list', 'agent_output', 'agent_kill']) {
    assert.ok(!fake.requests[0].tools.includes(name), `${name} must be absent by default`);
    assert.ok(fake.requests[1].tools.includes(name), `${name} must be present under swarm`);
  }
});

test('a spawned agent cannot spawn agents of its own', async (t) => {
  const root = tempRoot();
  const fake = await startFakeProvider(
    { toolCalls: [spawnCall({})] },
    { text: 'started it' },
    { text: 'done: nothing to change' },
  );
  t.after(() => fake.close());

  const session = makeSession(root, fake);
  t.after(() => session.dispose());
  await session.run('restyle things');
  await agentsSettled(session);

  const child = requestFor(fake, 'fast-model');
  // The bar is structural: the tool is absent from the belt rather than
  // forbidden in the prompt, so there is nothing to talk the model out of.
  assert.ok(!child.tools.includes('spawn_agent'), `got ${child.tools.join(', ')}`);
  const prompt = String(child.messages.find(m => m.role === 'system')?.content ?? '');
  assert.doesNotMatch(prompt, /spawn/i, 'a restriction worth naming would be one worth enforcing');
});

test('a spawned agent gets the toolset its parent asked for, and no more', async (t) => {
  const root = tempRoot();
  const fake = await startFakeProvider(
    { toolCalls: [spawnCall({ toolset: 'readonly' })] },
    { text: 'started it' },
    { text: 'done: had a look' },
  );
  t.after(() => fake.close());

  const session = makeSession(root, fake);
  t.after(() => session.dispose());
  await session.run('investigate');
  await agentsSettled(session);

  const child = requestFor(fake, 'fast-model');
  for (const kept of ['read_file', 'list_dir', 'search']) {
    assert.ok(child.tools.includes(kept), `readonly must keep ${kept}`);
  }
  for (const dropped of ['write_file', 'edit_file', 'run_shell', 'ask_user', 'shell_output']) {
    assert.ok(!child.tools.includes(dropped), `readonly must drop ${dropped}, got ${child.tools.join(', ')}`);
  }
});

test('the tier the parent picks is the model the agent runs on', async (t) => {
  const root = tempRoot();
  const fake = await startFakeProvider(
    { toolCalls: [spawnCall({ tier: 'deep' })] },
    { text: 'started it' },
    { text: 'done: nothing to change' },
  );
  t.after(() => fake.close());

  const session = makeSession(root, fake);
  t.after(() => session.dispose());
  await session.run('do the hard one');
  await agentsSettled(session);

  const job = session.agents.list()[0];
  assert.equal(job.tier, 'deep');
  assert.equal(job.label, 'llamacpp/deep-model');
  requestFor(fake, 'deep-model');
});

test('a denied spawn starts nothing', async (t) => {
  const root = tempRoot();
  const fake = await startFakeProvider(
    { toolCalls: [spawnCall({})] },
    { text: 'fine, I will do it myself' },
  );
  t.after(() => fake.close());

  const session = makeSession(root, fake, {}, {
    onOutput: () => {},
    requestApproval: async () => 'deny',
  });
  t.after(() => session.dispose());
  await session.run('restyle things');

  assert.deepEqual(session.agents.list(), [], 'the gate is what stands between a brief and an agent');
  assert.ok(!fake.requests.some(r => (r.body as { model?: string }).model === 'fast-model'));
});

test('the approval shows the brief whole, since that is what is being consented to', async (t) => {
  const root = tempRoot();
  const brief = 'rewrite the header styles in packages/ui, and do not touch the tests';
  const fake = await startFakeProvider(
    { toolCalls: [spawnCall({ brief })] },
    { text: 'ok' },
    { text: 'done: nothing to change' },
  );
  t.after(() => fake.close());

  const seen: string[] = [];
  const session = makeSession(root, fake, {}, {
    onOutput: () => {},
    requestApproval: async (request) => {
      if (request.toolName === 'spawn_agent') seen.push(request.detail);
      return 'approve';
    },
  });
  t.after(() => session.dispose());
  await session.run('restyle things');
  await agentsSettled(session);

  assert.deepEqual(seen, [brief]);
});

test('an agent that finishes reports back, once', async (t) => {
  const root = tempRoot();
  const fake = await startFakeProvider(
    { toolCalls: [spawnCall({})] },
    { text: 'started it' },
    { text: 'done: restyled the header\nchecked: nothing\nblocked: nothing' },
  );
  t.after(() => fake.close());

  const events: OutputEvent[] = [];
  const session = makeSession(root, fake, {}, {
    onOutput: (event) => { events.push(event); },
    requestApproval: async () => 'approve',
  });
  t.after(() => session.dispose());
  await session.run('restyle things');
  await agentsSettled(session);

  const done = events.find(e => e.type === 'agent-done');
  assert.ok(done, 'the parent has to be told, or delegation is a black hole');
  assert.equal(done.status, 'done');
  assert.equal(done.brief, 'restyle the header');

  // Drained by the report, so a parent that also polls does not pay twice.
  assert.equal(session.agents.read('agent1'), undefined);
  assert.equal(session.agents.get('agent1')?.status, 'done');
});

test('two agents editing one file both land', async (t) => {
  const root = tempRoot();
  writeFileSync(join(root, 'shared.txt'), 'alpha\nbeta\n');
  const edit = (oldString: string, newString: string) => ({
    toolCalls: [{ name: 'edit_file', arguments: { path: 'shared.txt', oldString, newString } }],
  });
  const fake = await startFakeProvider(
    { toolCalls: [spawnCall({ brief: 'uppercase alpha' }), spawnCall({ brief: 'uppercase beta' })] },
    { text: 'started both' },
    // Each agent reads first, because its own prompt tells it to and its own
    // readFiles map is empty — the point of not sharing that map.
    { toolCalls: [{ name: 'read_file', arguments: { path: 'shared.txt' } }] },
    { toolCalls: [{ name: 'read_file', arguments: { path: 'shared.txt' } }] },
    edit('alpha', 'ALPHA'),
    edit('beta', 'BETA'),
    { text: 'done: uppercased it' },
    { text: 'done: uppercased it' },
  );
  t.after(() => fake.close());

  const session = makeSession(root, fake);
  t.after(() => session.dispose());
  await session.run('uppercase both words');
  await agentsSettled(session);

  // The session-scoped lock is the only reason this holds: a belt-owned lock
  // gives each agent its own, and whichever wrote first is silently lost.
  assert.equal(readFileSync(join(root, 'shared.txt'), 'utf8'), 'ALPHA\nBETA\n');
});

test('a finished agent wakes the parent with agent wording, not shell wording', async (t) => {
  const root = tempRoot();
  const fake = await startFakeProvider(
    { toolCalls: [spawnCall({ toolset: 'readonly' })] },
    { text: 'started it' },
    { text: 'done: read it all\nchecked: nothing\nblocked: nothing' },
    { text: 'noted' },
  );
  t.after(() => fake.close());

  // Auto-resume on, which is the default a real session runs with.
  const session = makeSession(root, fake, { autoResume: true });
  t.after(() => session.dispose());
  await session.run('review the compression code');
  await agentsSettled(session);
  for (let i = 0; i < 100 && fake.pending > 0; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  const resumed = fake.requests.at(-1);
  const lastUser = [...(resumed?.messages ?? [])].reverse().find(m => m.role === 'user');
  const text = String(lastUser?.content ?? '');
  // A review agent's report is a claim to weigh. Told to "diagnose and fix"
  // what failed, a model goes looking for a repair nobody asked for.
  assert.match(text, /verify the parts your next step depends on/i);
  assert.doesNotMatch(text, /background job above/i);
});

test('stopping the session stops its agents', async (t) => {
  const root = tempRoot();
  const fake = await startFakeProvider({ text: 'ok' });
  t.after(() => fake.close());

  const session = makeSession(root, fake);
  // Driven through the registry rather than a scripted spawn: whether the
  // parent's second request or the agent's first reaches the fake provider
  // first is a race, so a scripted agent is sometimes already finished by the
  // time there is anything to kill. What this needs to pin down is the wiring —
  // that `dispose` reaches the same registry `spawn_agent` starts jobs in — and
  // a job that never settles states that without depending on the race.
  session.agents.start({
    brief: 'something long-running',
    tier: 'fast',
    toolset: 'edit',
    label: 'llamacpp/fast-model',
    run: () => new Promise<string>(() => {}),
  });
  assert.equal(session.agents.list()[0].status, 'running');

  session.dispose();
  // An abandoned agent with write tools is the one that matters: it would keep
  // editing files for a conversation that no longer exists.
  assert.equal(session.agents.list()[0].status, 'killed');
});
