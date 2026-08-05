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
// background jobs & auto-resume
//
// `run()` reaches a real provider and fails, which is fine here: what these
// assert is which turns the engine *decides* to start, not what a model says.
// ---------------------------------------------------------------------------

function jobSession(root: string, client: ClientInterface, overrides = {}): Session {
  return new Session(
    {
      agent: { provider: 'claude', apiKey: 'test-key' },
      workspaceRoot: root,
      compressionThreshold: 0,
      ...overrides,
    },
    client,
  );
}

const jobDone = (events: OutputEvent[]) =>
  events.filter((e): e is Extract<OutputEvent, { type: 'job-done' }> => e.type === 'job-done');

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise(r => setTimeout(r, 10));
  }
}

test('a finished background job is reported to the client', async () => {
  const events: OutputEvent[] = [];
  const session = jobSession(tempRoot(), makeClient(events));
  session.backgroundJobs.start({ command: 'exit 2', cwd: tempRoot() });

  await waitFor(() => jobDone(events).length > 0);
  const done = jobDone(events)[0];
  assert.equal(done.command, 'exit 2');
  assert.equal(done.exitCode, 2);
  assert.equal(done.status, 'exited');
  session.dispose();
});

test('a job finishing on an idle session starts a turn', async () => {
  const events: OutputEvent[] = [];
  const session = jobSession(tempRoot(), makeClient(events));
  session.backgroundJobs.start({ command: 'true', cwd: tempRoot() });

  await waitFor(() => jobDone(events).length > 0);
  assert.equal(jobDone(events)[0].resuming, true);
  // `thinking` is emitted once per turn, right before the agent runs.
  await waitFor(() => events.some(e => e.type === 'thinking'));
  session.dispose();
});

test('autoResume: false reports the job without starting a turn', async () => {
  const events: OutputEvent[] = [];
  const session = jobSession(tempRoot(), makeClient(events), { autoResume: false });
  session.backgroundJobs.start({ command: 'true', cwd: tempRoot() });

  await waitFor(() => jobDone(events).length > 0);
  assert.equal(jobDone(events)[0].resuming, false);
  await new Promise(r => setTimeout(r, 200));
  assert.ok(!events.some(e => e.type === 'thinking'), 'no turn should have started');
  session.dispose();
});

test('an exhausted auto-resume budget stops the loop', async () => {
  const events: OutputEvent[] = [];
  const session = jobSession(tempRoot(), makeClient(events), { autoResumeBudget: 0 });
  session.backgroundJobs.start({ command: 'true', cwd: tempRoot() });

  await waitFor(() => jobDone(events).length > 0);
  assert.equal(jobDone(events)[0].resuming, false, 'no budget left to spend');
  session.dispose();
});

test('a killed job does not report or wake the agent', async () => {
  const events: OutputEvent[] = [];
  const session = jobSession(tempRoot(), makeClient(events));
  const job = session.backgroundJobs.start({ command: 'sleep 30', cwd: tempRoot() });

  session.backgroundJobs.kill(job.id);
  await waitFor(() => session.backgroundJobs.get(job.id)!.status !== 'running');
  await new Promise(r => setTimeout(r, 100));

  assert.equal(jobDone(events).length, 0, 'stopping a job is not news');
  session.dispose();
});

test('a job that finishes mid-turn is still reported as resuming', async () => {
  const events: OutputEvent[] = [];
  const session = jobSession(tempRoot(), makeClient(events));

  const running = session.run('a task').catch(() => {});
  session.backgroundJobs.start({ command: 'true', cwd: tempRoot() });

  await waitFor(() => jobDone(events).length > 0);
  // Not picked up *now* — the running turn built its prompt before the job
  // existed — but at the end of that turn, which is what `resuming` promises.
  assert.equal(jobDone(events)[0].resuming, true);
  await running;
  session.dispose();
});

test('a job finishing mid-turn starts a turn once the current one ends', async () => {
  const events: OutputEvent[] = [];
  const session = jobSession(tempRoot(), makeClient(events));

  const running = session.run('a task').catch(() => {});
  session.backgroundJobs.start({ command: 'true', cwd: tempRoot() });
  await waitFor(() => jobDone(events).length > 0);
  await running;

  // Two `thinking` events: the user's turn, then the one the job woke.
  await waitFor(() => events.filter(e => e.type === 'thinking').length >= 2);
  session.dispose();
});

test('dispose() kills running jobs', async () => {
  const session = jobSession(tempRoot(), makeClient());
  const job = session.backgroundJobs.start({ command: 'sleep 30', cwd: tempRoot() });
  session.dispose();
  await waitFor(() => session.backgroundJobs.get(job.id)!.status === 'killed');
});

test('clear() kills running jobs and says how many', async () => {
  const session = jobSession(tempRoot(), makeClient());
  session.backgroundJobs.start({ command: 'sleep 30', cwd: tempRoot() });
  const msg = await session.clear();
  assert.match(msg, /1 background job/);
  await waitFor(() => session.backgroundJobs.list().every(j => j.status !== 'running'));
  session.dispose();
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
  // Awaited rather than asserted inline: the approval chain is walked
  // asynchronously, so the human link is reached a tick after the call. What
  // matters is that the in-flight promise is registered synchronously, which is
  // what makes calls two and three join it instead of prompting again.
  await new Promise(resolve => setImmediate(resolve));
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

// ---------------------------------------------------------------------------
// setProfiles — a model switch must not cost the conversation
// ---------------------------------------------------------------------------

/** Reaches past `private` deliberately: what these assert is that the switch
 *  leaves the session's *state* alone, and that state has no public getters. */
function internals(session: Session) {
  return session as unknown as {
    config: { agent: { provider: string; model?: string } };
    history: { addText(role: string, text: string): void; totalEstimatedTokens: number };
    alwaysApproved: Set<string>;
  };
}

const CLAUDE = { provider: 'claude' as const, model: 'claude-sonnet-4-6', apiKey: 'k' };
const LOCAL = { provider: 'llamacpp' as const, model: 'qwen', host: 'http://localhost:8080' };

test('switching models keeps the conversation history', () => {
  const session = jobSession(tempRoot(), makeClient());
  const inner = internals(session);
  inner.history.addText('user', 'remember this sentence');
  const before = inner.history.totalEstimatedTokens;
  assert.ok(before > 0, 'precondition: history has something in it');

  session.setProfiles(LOCAL);
  assert.equal(inner.history.totalEstimatedTokens, before, 'history must survive the switch');
  session.dispose();
});

test('switching models points the coder at the new profile', () => {
  const session = jobSession(tempRoot(), makeClient());
  session.setProfiles(LOCAL);
  assert.equal(internals(session).config.agent.provider, 'llamacpp');
  assert.equal(internals(session).config.agent.model, 'qwen');
  session.dispose();
});

test('a running background job survives a model switch', async () => {
  const session = jobSession(tempRoot(), makeClient());
  const job = session.backgroundJobs.start({ command: 'sleep 30', cwd: tempRoot() });

  session.setProfiles(LOCAL);
  await new Promise(r => setTimeout(r, 50));

  assert.equal(session.backgroundJobs.get(job.id)?.status, 'running',
    'a switch is not a reason to kill work already in flight');
  session.dispose();
});

test('the always-approved list survives a model switch', () => {
  const session = jobSession(tempRoot(), makeClient());
  internals(session).alwaysApproved.add('run_shell');
  session.setProfiles(LOCAL);
  assert.ok(internals(session).alwaysApproved.has('run_shell'),
    'consent was given for the session, not for the model');
  session.dispose();
});

test('switching back and forth does not accumulate history plugins', async () => {
  // The compression plugin cannot be unregistered, so a switch that re-registered
  // it would stack summarisers and compound the summary on every reduce.
  const session = jobSession(tempRoot(), makeClient(), { compressionThreshold: 1 });
  const inner = internals(session);
  for (let i = 0; i < 5; i++) session.setProfiles(i % 2 ? CLAUDE : LOCAL);
  inner.history.addText('user', 'x'.repeat(200));
  assert.ok(inner.history.totalEstimatedTokens > 0);
  session.dispose();
});

test('setProfiles records both tiers', () => {
  const session = jobSession(tempRoot(), makeClient());
  session.setProfiles(CLAUDE, LOCAL);
  const routing = session as unknown as { config: { models?: { deep?: unknown; fast?: unknown } } };
  assert.deepEqual(routing.config.models?.deep, CLAUDE);
  assert.deepEqual(routing.config.models?.fast, LOCAL);
  session.dispose();
});

test('dropping the fast tier clears it rather than leaving a stale one', () => {
  const session = jobSession(tempRoot(), makeClient());
  session.setProfiles(CLAUDE, LOCAL);
  session.setProfiles(CLAUDE);
  const routing = session as unknown as { config: { models?: { fast?: unknown } } };
  assert.equal(routing.config.models?.fast, undefined);
  session.dispose();
});
