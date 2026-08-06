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

test('interrupting a slow turn reports it and keeps the task as steering context', async (t) => {
  const root = tempRoot();
  // The turn cannot finish before the interrupt lands.
  const fake = await startFakeProvider({ text: 'much later', delayMs: 3000 });
  t.after(() => fake.close());

  const { client, events } = collector();
  const session = makeSession(root, fake, client);
  t.after(() => session.dispose());

  const running = session.run('a task that will be cut short');
  await waitFor(() => events.some(e => e.type === 'thinking'), 5000, 'the turn to start');
  session.interrupt();
  await running;

  assert.ok(events.some(e => e.type === 'interrupted'), 'the client is told the turn was interrupted');
  assert.ok(!events.some(e => e.type === 'response'), 'no answer is reported for an interrupted turn');
  assert.equal(session.hasSteering, true,
    'the abandoned task is kept, so the next message can course-correct instead of starting over');
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
