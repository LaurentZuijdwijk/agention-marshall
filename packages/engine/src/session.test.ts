import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Session } from './session.js';
import type { ClientInterface, OutputEvent } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'marshall-session-test-'));
}

function makeClient(events: OutputEvent[] = []): ClientInterface {
  return {
    onOutput: (event) => { events.push(event); },
    requestApproval: async () => 'approve',
  };
}

function makeSession(root: string, client: ClientInterface): Session {
  return new Session(
    {
      agent: { provider: 'claude', apiKey: 'test-key' },
      workspaceRoot: root,
      compressionThreshold: 0, // disable compression to avoid async agent creation
    },
    client,
  );
}

// ---------------------------------------------------------------------------
// hasSteering
// ---------------------------------------------------------------------------

test('hasSteering is false on a new session', () => {
  const root = tempRoot();
  const session = makeSession(root, makeClient());
  assert.equal(session.hasSteering, false);
});

// ---------------------------------------------------------------------------
// interrupt()
// ---------------------------------------------------------------------------

test('interrupt() on an idle session does not throw', () => {
  const root = tempRoot();
  const session = makeSession(root, makeClient());
  assert.doesNotThrow(() => session.interrupt());
});

test('interrupt() on an idle session leaves hasSteering false', () => {
  const root = tempRoot();
  const session = makeSession(root, makeClient());
  session.interrupt();
  assert.equal(session.hasSteering, false);
});

// ---------------------------------------------------------------------------
// run() — concurrency guard
// ---------------------------------------------------------------------------

test('calling run() while a run is already in progress emits an error event', async () => {
  const root = tempRoot();
  const events: OutputEvent[] = [];
  const client = makeClient(events);
  const session = makeSession(root, client);

  // First run will fail eventually (no real Claude endpoint), but the
  // controller is claimed synchronously before any await, so the second
  // call will be rejected immediately.
  const first = session.run('task one').catch(() => {});
  const second = session.run('task two').catch(() => {});

  await Promise.all([first, second]);

  const errorEvents = events.filter(
    (e): e is Extract<OutputEvent, { type: 'error' }> => e.type === 'error',
  );

  const concurrencyError = errorEvents.find((e) =>
    e.message.toLowerCase().includes('already running'),
  );

  assert.ok(concurrencyError, 'expected an "already running" error event');
});

// ---------------------------------------------------------------------------
// clear()
// ---------------------------------------------------------------------------

test('clear() returns a message when no notes exist', async () => {
  const root = tempRoot();
  const session = makeSession(root, makeClient());
  const msg = await session.clear();
  assert.match(msg, /history/i);
  // No notes dir → no notes cleared
  assert.doesNotMatch(msg, /note/i);
});

test('clear() removes .md files from .marshall/notes/', async () => {
  const root = tempRoot();
  const notesDir = join(root, '.marshall', 'notes');
  mkdirSync(notesDir, { recursive: true });
  writeFileSync(join(notesDir, 'plan.md'), '# plan');
  writeFileSync(join(notesDir, 'scratch.md'), '# scratch');
  writeFileSync(join(notesDir, 'keep.txt'), 'not a note'); // should not be removed

  const session = makeSession(root, makeClient());
  const msg = await session.clear();

  const remaining = readdirSync(notesDir);
  assert.ok(!remaining.includes('plan.md'), 'plan.md should be deleted');
  assert.ok(!remaining.includes('scratch.md'), 'scratch.md should be deleted');
  assert.ok(remaining.includes('keep.txt'), 'keep.txt should be kept');
  assert.match(msg, /2 scratch notes/);
});

test('clear() returns singular "note" for exactly one note', async () => {
  const root = tempRoot();
  const notesDir = join(root, '.marshall', 'notes');
  mkdirSync(notesDir, { recursive: true });
  writeFileSync(join(notesDir, 'only.md'), '# only');

  const session = makeSession(root, makeClient());
  const msg = await session.clear();
  assert.match(msg, /1 scratch note[^s]/);
});

test('clear() resets hasSteering', async () => {
  // We can't easily set steeringContext without running a task, but we can
  // verify clear() completes and hasSteering remains false.
  const root = tempRoot();
  const session = makeSession(root, makeClient());
  await session.clear();
  assert.equal(session.hasSteering, false);
});
