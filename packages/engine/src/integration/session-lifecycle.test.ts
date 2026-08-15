// ── engine integration: the parts that aren't one clean turn ──────────────────
//
// Interrupting a turn, and a background job waking the agent up on its own.
// Both are timing-shaped and neither is reachable from a unit test: one needs a
// provider that is genuinely slow to answer, the other needs a real process to
// exit while the session sits idle.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Session } from '../session.js';
import { startFakeProvider } from '../testing/fake-provider.js';
import type { FakeProvider } from '../testing/fake-provider.js';
import type { ClientInterface, OutputEvent } from '../types.js';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'marshall-integration-'));
}

function collector(): { client: ClientInterface; events: OutputEvent[] } {
  const events: OutputEvent[] = [];
  return {
    events,
    client: {
      onOutput: (event) => { events.push(event); },
      requestApproval: async () => 'approve',
    },
  };
}

function makeSession(root: string, fake: FakeProvider, client: ClientInterface): Session {
  return new Session(
    {
      agent: { provider: 'llamacpp', host: fake.host, model: 'test-model' },
      workspaceRoot: root,
      compressionThreshold: 0,
      enableWebSearch: false,
    },
    client,
  );
}

/** Poll until `predicate` holds, so tests wait on the event rather than a guess. */
async function waitFor(predicate: () => boolean, timeoutMs = 5000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

// Two windows, because the turn is announced when the session is claimed and the
// request goes out some way after that. Esc is reachable in both, and they fail
// differently: mid-stream there is a request to abandon, during setup there is a
// listener that will never fire on an already-aborted signal.
test('interrupting a turn mid-stream reports it and keeps the task as steering context', async (t) => {
  const root = tempRoot();
  // Paced chunks, so the turn is still streaming when the interrupt lands.
  const fake = await startFakeProvider({
    text: 'an answer that arrives piece by piece',
    chunkDelayMs: 100,
  });
  t.after(() => fake.close());

  const { client, events } = collector();
  const session = makeSession(root, fake, client);
  t.after(() => session.dispose());

  const running = session.run('a task that will be cut short');
  // The first token, not `thinking`: that is the earliest proof the request is
  // out and the model is answering, which is the window this test is about.
  await waitFor(() => events.some(e => e.type === 'token'), 5000, 'the answer to start arriving');
  session.interrupt();
  await running;

  assert.ok(events.some(e => e.type === 'interrupted'), 'the client is told the turn was interrupted');
  assert.ok(!events.some(e => e.type === 'response'), 'no answer is reported for an interrupted turn');
  assert.equal(session.hasSteering, true,
    'the abandoned task is kept, so the next message can course-correct instead of starting over');
});

test('interrupting a turn before its request goes out reports it and sends nothing', async (t) => {
  const root = tempRoot();
  const fake = await startFakeProvider({ text: 'an answer nobody asked for any more' });
  t.after(() => fake.close());

  const { client, events } = collector();
  const session = makeSession(root, fake, client);
  t.after(() => session.dispose());

  const running = session.run('a task called off before it started');
  // `thinking` now lands when the session is claimed, which is before the tool
  // belt, MCP and the agent are ready — so this is an Esc during setup, the
  // window the spinner newly covers.
  await waitFor(() => events.some(e => e.type === 'thinking'), 5000, 'the turn to be announced');
  session.interrupt();
  await running;

  assert.equal(fake.requests.length, 0, 'a turn called off before it was sent must not reach the model');
  assert.ok(events.some(e => e.type === 'interrupted'), 'the client is told the turn was interrupted');
  assert.ok(!events.some(e => e.type === 'response'), 'no answer is reported for an interrupted turn');
  assert.equal(session.hasSteering, true, 'the task is kept even though the turn never got as far as sending it');
});

// /plan, /goal and /review run through `runSideAgent` rather than `run`, and
// used to have none of the interrupt handling above: no abort-before-the-call
// guard, and a catch block that reported every abort as a generic error
// instead of `interrupted` — so Esc during a long `/review` did nothing but
// mislabel the eventual result as a failure. Both turn kinds now share the
// same lifecycle helpers in Session, which is what these two mirror the `run`
// tests above to prove.
test('interrupting a side-agent turn before its request goes out reports it and sends nothing', async (t) => {
  const root = tempRoot();
  const fake = await startFakeProvider({ text: 'a plan nobody asked for any more' });
  t.after(() => fake.close());

  const { client, events } = collector();
  const session = makeSession(root, fake, client);
  t.after(() => session.dispose());

  const planning = session.plan('a plan called off before it started');
  await waitFor(() => events.some(e => e.type === 'thinking'), 5000, 'the turn to be announced');
  session.interrupt();
  await planning;

  assert.equal(fake.requests.length, 0, 'a turn called off before it was sent must not reach the model');
  assert.ok(events.some(e => e.type === 'interrupted'), 'the client is told the turn was interrupted');
  assert.ok(!events.some(e => e.type === 'plan'), 'no plan is reported for an interrupted turn');
  assert.equal(session.hasSteering, true, 'the prompt is kept even though the turn never got as far as sending it');
});

test('interrupting a side-agent turn mid-request reports it and keeps the prompt as steering context', async (t) => {
  const root = tempRoot();
  // Held open long enough that the interrupt lands while `agent.execute` is
  // still awaiting the response — the window `raceAbort` exists for, since
  // `execute()` has no cancellation hook of its own.
  const fake = await startFakeProvider({ text: 'a plan that takes a while', delayMs: 300 });
  t.after(() => fake.close());

  const { client, events } = collector();
  const session = makeSession(root, fake, client);
  t.after(() => session.dispose());

  const planning = session.plan('a plan that will be cut short');
  await waitFor(() => fake.requests.length > 0, 5000, 'the request to reach the fake provider');
  session.interrupt();
  await planning;

  assert.ok(events.some(e => e.type === 'interrupted'), 'the client is told the turn was interrupted');
  assert.ok(!events.some(e => e.type === 'plan'), 'no plan is reported for an interrupted turn');
  assert.equal(session.hasSteering, true,
    'the abandoned prompt is kept, so the next message can course-correct instead of starting over');
});

test('a background job finishing while idle wakes the agent', async (t) => {
  const root = tempRoot();
  const fake = await startFakeProvider(
    // Turn 1: start something detached. Turn 2: acknowledge and stop.
    { toolCalls: [{ name: 'run_shell', arguments: { command: 'echo started', background: true } }] },
    { text: 'Started it in the background.' },
    // Turn 3 is the unattended one, driven by the job's exit.
    { text: 'The job finished cleanly — nothing else to do.' },
  );
  t.after(() => fake.close());

  const { client, events } = collector();
  const session = makeSession(root, fake, client);
  t.after(() => session.dispose());

  await session.run('run echo started in the background');

  const done = await waitFor(() => events.some(e => e.type === 'job-done'), 5000, 'the job to exit')
    .then(() => events.find(e => e.type === 'job-done') as Extract<OutputEvent, { type: 'job-done' }>);
  assert.equal(done.exitCode, 0);
  assert.equal(done.resuming, true, 'auto-resume is on, so the client should be told a turn is coming');

  // The wake-up turn is the whole point: nobody asked for it.
  await waitFor(() => events.filter(e => e.type === 'response').length === 2, 5000, 'the resumed turn');
  const answers = events.filter(e => e.type === 'response').map(e => (e as { text: string }).text);
  assert.deepEqual(answers, ['Started it in the background.', 'The job finished cleanly — nothing else to do.']);

  // And it must carry the job's outcome, or the model is answering about nothing.
  const resumed = fake.requests[fake.requests.length - 1];
  const lastUser = resumed.messages.filter(m => m.role === 'user').pop();
  assert.match(JSON.stringify(lastUser?.content), /Background job finished/,
    'the resumed turn is prefixed with the job report');
});
