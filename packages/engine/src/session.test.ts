import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Session, assistantText } from './session.js';
import type { ClientInterface, OutputEvent, ApprovalRequest, ApprovalDecision } from './types.js';

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

// ---------------------------------------------------------------------------
// plan() / review()
// ---------------------------------------------------------------------------

test('hasPendingPlan is false on a new session', () => {
  const root = tempRoot();
  const session = makeSession(root, makeClient());
  assert.equal(session.hasPendingPlan, false);
});

test('plan() while a run is already in progress emits an error event', async () => {
  const root = tempRoot();
  const events: OutputEvent[] = [];
  const client = makeClient(events);
  const session = makeSession(root, client);

  const first = session.run('task one').catch(() => {});
  const second = session.plan('plan this').catch(() => {});

  await Promise.all([first, second]);

  const errorEvents = events.filter(
    (e): e is Extract<OutputEvent, { type: 'error' }> => e.type === 'error',
  );
  const concurrencyError = errorEvents.find((e) =>
    e.message.toLowerCase().includes('already running'),
  );
  assert.ok(concurrencyError, 'expected an "already running" error event');
});

test('review() while a run is already in progress emits an error event', async () => {
  const root = tempRoot();
  const events: OutputEvent[] = [];
  const client = makeClient(events);
  const session = makeSession(root, client);

  const first = session.run('task one').catch(() => {});
  const second = session.review().catch(() => {});

  await Promise.all([first, second]);

  const errorEvents = events.filter(
    (e): e is Extract<OutputEvent, { type: 'error' }> => e.type === 'error',
  );
  const concurrencyError = errorEvents.find((e) =>
    e.message.toLowerCase().includes('already running'),
  );
  assert.ok(concurrencyError, 'expected an "already running" error event');
});

test('clear() resets hasPendingPlan', async () => {
  const root = tempRoot();
  const session = makeSession(root, makeClient());
  await session.clear();
  assert.equal(session.hasPendingPlan, false);
});

// ---------------------------------------------------------------------------
// tier routing — the session must actually consult the tier config, not just
// config.agent. This is the wiring that made /model fast a no-op at run time.
// ---------------------------------------------------------------------------

/** Poll for the session log, which is written fire-and-forget. */
async function readSessionLog(root: string): Promise<string> {
  const path = join(root, '.marshall', 'logs', 'session.log');
  for (let i = 0; i < 50; i++) {
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf8');
      if (text.includes('TIERS ')) return text;
    }
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('session log never got a TIERS line');
}

test('a fast tier routes the reading roles off the deep model', async () => {
  const root = tempRoot();
  new Session(
    {
      agent: { provider: 'claude', apiKey: 'test-key' },
      workspaceRoot: root,
      compressionThreshold: 0,
      models: {
        deep: { provider: 'claude', model: 'claude-opus-4-6', apiKey: 'test-key' },
        fast: { provider: 'llamacpp', model: 'gemma-local', host: 'http://localhost:8080' },
      },
    },
    makeClient(),
  );

  const line = (await readSessionLog(root)).split('\n').find(l => l.includes('TIERS '))!;

  // deciding roles stay on the deep model, untagged
  assert.match(line, /coder=claude\/claude-opus-4-6(?!\*)/);
  assert.match(line, /planner=claude\/claude-opus-4-6(?!\*)/);
  // reading roles move to the fast model and are tagged as delegated
  assert.match(line, /context=llamacpp\/gemma-local\*/);
  assert.match(line, /summarizer=llamacpp\/gemma-local\*/);
});

test('without a fast tier every role stays on the main agent', async () => {
  const root = tempRoot();
  new Session(
    {
      agent: { provider: 'llamacpp', model: 'gemma-local', host: 'http://localhost:8080' },
      workspaceRoot: root,
      compressionThreshold: 0,
    },
    makeClient(),
  );

  const line = (await readSessionLog(root)).split('\n').find(l => l.includes('TIERS '))!;
  assert.equal(line.includes('*'), false, `expected nothing delegated, got: ${line}`);
});

// ---------------------------------------------------------------------------
// always-approve coalescing for parallel tool calls
// ---------------------------------------------------------------------------

test('parallel approvals for the same tool coalesce into one user decision', async () => {
  const root = tempRoot();

  let releasedResolve: (d: ApprovalDecision) => void = () => {};
  let approvalCalls = 0;
  const decision: Promise<ApprovalDecision> = new Promise((resolve) => { releasedResolve = resolve; });

  const client: ClientInterface = {
    onOutput: () => {},
    requestApproval: (_req: ApprovalRequest) => {
      approvalCalls += 1;
      return decision;
    },
  };
  const session = new Session(
    { agent: { provider: 'claude', apiKey: 'test-key' }, workspaceRoot: root, compressionThreshold: 0 },
    client,
  );

  // Reach the private approval function directly — the public surface can't
  // drive it without a live LLM turn.
  const approve = (session as unknown as { makeApproval(): (r: ApprovalRequest) => Promise<ApprovalDecision> })
    .makeApproval();

  const req = { toolName: 'edit_file', description: 'edit', detail: 'diff' } as ApprovalRequest;
  const first = approve(req);
  const second = approve(req);
  const third = approve(req);

  // Only the first request reaches the user; the rest wait on the same decision.
  assert.equal(approvalCalls, 1, 'same-tool parallel calls must share one user decision');

  releasedResolve('always');
  const [a, b, c] = await Promise.all([first, second, third]);
  assert.deepEqual([a, b, c], ['always', 'always', 'always']);
  assert.equal(approvalCalls, 1);

  // And subsequent calls are auto-approved from the always-allow set.
  const fourth = approve(req);
  assert.equal(approvalCalls, 1, 'always-approve must cover later calls to the same tool');
  assert.equal(await fourth, 'approve');
});


// ---------------------------------------------------------------------------
// assistantText() — what the model said before its tool calls
// ---------------------------------------------------------------------------

test('assistantText picks the prose out of an Anthropic content array', () => {
  const content = [
    { type: 'text', text: 'Reading the config first.' },
    { type: 'tool_use', name: 'read_file', input: { path: 'a.ts' } },
  ];
  assert.equal(assistantText(content), 'Reading the config first.');
});

test('assistantText joins several text blocks in order', () => {
  const content = [
    { type: 'text', text: 'One.' },
    { type: 'text', text: 'Two.' },
    { type: 'tool_use', name: 'read_file', input: {} },
  ];
  assert.equal(assistantText(content), 'One.\nTwo.');
});

test('assistantText is empty for chat-completions tool calls, which carry no text', () => {
  // These providers stream their prose as tokens instead, so inventing a row
  // here would show the same message twice.
  const toolCalls = [{ id: '1', type: 'function', function: { name: 'read_file', arguments: '{}' } }];
  assert.equal(assistantText(toolCalls), '');
});

test('assistantText ignores blocks that only look like text', () => {
  assert.equal(assistantText([{ type: 'text' }, { type: 'text', text: 42 }, null]), '');
});
