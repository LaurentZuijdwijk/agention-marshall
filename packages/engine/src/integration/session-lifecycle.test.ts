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
import { History, toolResult } from '@agentionai/agents/core';
import { Session } from '../session.js';
import { startFakeProvider } from '../testing/fake-provider.js';
import type { FakeProvider, ScriptedTurn } from '../testing/fake-provider.js';
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

function makeSession(
  root: string,
  fake: FakeProvider,
  client: ClientInterface,
  overrides: Partial<ConstructorParameters<typeof Session>[0]> = {},
): Session {
  return new Session(
    {
      agent: { provider: 'llamacpp', host: fake.host, model: 'test-model' },
      workspaceRoot: root,
      compressionThreshold: 0,
      enableWebSearch: false,
      ...overrides,
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

// The library writes the assistant's tool_use to history as soon as it finishes
// streaming, then awaits the tool — so an interrupt that lands during approval
// or execution leaves that call answered nowhere *until* whatever it was
// waiting on eventually settles in the background. A provider that requires
// every call to be answered rejects the *next* request outright if it goes out
// first, and that 400 carries no context-length wording, so past regressions
// have mistaken it for a full context window and burned a compression pass
// that could never fix it. The approval below is deliberately slower than the
// follow-up turn's own setup, so the follow-up's request is built while the
// call is still genuinely unanswered — the exact window the repair has to
// close before the next request can carry it.
test('interrupting mid-tool-call leaves no unanswered call for the next turn', async (t) => {
  const root = tempRoot();
  const fake = await startFakeProvider(
    { toolCalls: [{ name: 'run_shell', arguments: { command: 'echo hi' }, id: 'call_slow' }] },
    { text: 'the next thing' },
  );
  t.after(() => fake.close());

  const events: OutputEvent[] = [];
  const client: ClientInterface = {
    onOutput: (event) => { events.push(event); },
    requestApproval: async () => {
      await new Promise(resolve => setTimeout(resolve, 300));
      return 'approve';
    },
  };
  const session = makeSession(root, fake, client);
  t.after(() => session.dispose());

  const running = session.run('run something that needs approval');
  // Fired once the model's tool_use is complete and already in history — well
  // before the slow approval above has a chance to resolve.
  await waitFor(() => events.some(e => e.type === 'tool-call'), 5000, 'the tool call to be dispatched');
  session.interrupt();
  await running;

  assert.ok(events.some(e => e.type === 'interrupted'), 'the client is told the turn was interrupted');
  assert.equal(session.hasSteering, true);

  await session.run('a follow-up task');
  const sent = fake.requests.at(-1)?.messages ?? [];
  const calledIds = sent
    .flatMap(m => {
      const calls = (m as { tool_calls?: unknown }).tool_calls;
      return Array.isArray(calls) ? calls as { id: string }[] : [];
    })
    .map(c => c.id);
  const answeredIds = new Set(sent.filter(m => m.role === 'tool').map(m => m.tool_call_id));
  for (const id of calledIds) {
    assert.ok(answeredIds.has(id), `tool call ${id} sent with no matching result in the same request`);
  }
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

test('a job that finishes while the model is still working keeps its output for shell_output', async (t) => {
  const root = tempRoot();
  const fake = await startFakeProvider(
    { toolCalls: [{ name: 'run_shell', arguments: { command: 'echo $((6*7))', background: true } }] },
    { text: 'Started it in the background.' },
    { text: 'noted' },
  );
  t.after(() => fake.close());

  const { client, events } = collector();
  // Auto-resume off, so the report is queued and not delivered — the same
  // state a job is in when it exits mid-turn, where the model's next move is
  // often `shell_output` on it. That used to answer "no new output", because
  // the exit handler had already drained the output into the queue.
  const session = makeSession(root, fake, client, { autoResume: false });
  t.after(() => session.dispose());

  await session.run('run it in the background');
  await waitFor(() => events.some(e => e.type === 'job-done'), 5000, 'the job to exit');

  const output = session.backgroundJobs.read('job1');
  assert.match(output?.stdout ?? '', /\b42\b/, 'the output is still there to be read');

  // And the wake-up says it was read, rather than repeating it.
  await session.run('carry on');
  const resumed = fake.requests[fake.requests.length - 1];
  const lastUser = resumed.messages.filter(m => m.role === 'user').pop();
  const text = JSON.stringify(lastUser?.content);
  assert.match(text, /Background job finished/);
  assert.match(text, /already read its output with shell_output/);
  assert.doesNotMatch(text, /\b42\b/, 'paid for once, via shell_output');
});

// A tool result whose call is gone is rejected exactly like a call with no
// result — OpenAI, Azure and OpenRouter all answer with a bare 400, and because
// it carries no context-length wording the engine used to read it as an
// overflow and answer with a compression pass. Compression is also what creates
// it: summarising a middle window that ends between a call and its result. The
// pairing is repaired before the request goes out, so a session already carrying
// a broken one heals instead of failing every turn from there on.
test('a tool result stranded from its call is repaired before the next request', async (t) => {
  const root = tempRoot();
  const fake = await startFakeProvider({ text: 'acknowledged' });
  t.after(() => fake.close());

  const { client } = collector();
  const session = makeSession(root, fake, client);
  t.after(() => session.dispose());

  const history = (session as unknown as { history: History }).history;
  history.addText('user', 'an earlier question');
  // What compression leaves behind: the assistant entry holding the call is
  // summarised away, the entry holding its result is kept.
  history.addMessage('user', [toolResult('call_gone', 'file contents', false)]);

  await session.run('carry on');

  const sent = fake.requests.at(-1)?.messages ?? [];
  const calledIds = new Set(sent.flatMap(m => {
    const calls = (m as { tool_calls?: { id: string }[] }).tool_calls;
    return Array.isArray(calls) ? calls.map(c => c.id) : [];
  }));
  const answeredIds = sent.filter(m => m.role === 'tool')
    .map(m => m.tool_call_id)
    .filter((id): id is string => id !== undefined);

  for (const id of answeredIds) {
    assert.ok(calledIds.has(id), `tool result ${id} sent with no matching call in the same request`);
  }
  assert.ok(!answeredIds.includes('call_gone'), 'the stranded result must not reach the provider');
});

// ── which failures are worth compressing for ──────────────────────────────────
//
// Compression on an error is a guess: llama.cpp answers an overflow with a bare
// `Provider returned error`, so requiring the provider to *say* "context" would
// leave local models with no recovery. The cost is that every 400 the engine has
// not been taught about is treated as a maybe-overflow — it pops the turn's last
// message, compresses history, and reports a full context window that the
// provider never claimed. These pin down which side of that line each failure
// falls on, with enough history that compression would genuinely find something
// to cut and so would otherwise "succeed".

async function sessionWithHistory(t: { after: (fn: () => unknown) => void }, turn: ScriptedTurn) {
  const root = tempRoot();
  const fake = await startFakeProvider(turn);
  t.after(() => fake.close());
  const { client, events } = collector();
  // Compression on, and a history well under the threshold: proactive
  // compression stays out of the way, so what these observe is only what the
  // *error* triggered. The summariser runs against the same fake provider,
  // whose script has run dry by then and answers with plain text.
  const session = makeSession(root, fake, client, { compressionThreshold: 40_000 });
  t.after(() => session.dispose());

  const history = (session as unknown as { history: History }).history;
  for (let i = 0; i < 20; i++) history.addText('user', 'x'.repeat(2_000));

  return { session, events };
}

test('a content filter rejection is reported, not compressed away as a full context window', async (t) => {
  const { session, events } = await sessionWithHistory(t, {
    error: {
      status: 400,
      message: "The response was filtered due to the prompt triggering Azure OpenAI's content management policy.",
    },
  });

  await session.run('do the thing');

  assert.ok(!events.some(e => e.type === 'context-full'),
    'a filtered prompt is not an overflow — shrinking history cannot fix it');
  const errors = events.filter(e => e.type === 'error');
  assert.equal(errors.length, 1, `the provider error should be reported once: ${JSON.stringify(events.map(e => e.type))}`);
  assert.match((errors[0] as { message: string }).message, /content management policy/);
});

test('a rejected tool schema is reported, not compressed away as a full context window', async (t) => {
  const { session, events } = await sessionWithHistory(t, {
    error: { status: 400, message: "Invalid schema for function 'read_file': 'startLine' is not of type 'object'." },
  });

  await session.run('do the thing');

  assert.ok(!events.some(e => e.type === 'context-full'));
  assert.ok(events.some(e => e.type === 'error' && /Invalid schema/.test((e as { message: string }).message)));
});

test('an unlabelled 400 is still treated as a possible overflow, since some providers report one that way', async (t) => {
  const { session, events } = await sessionWithHistory(t, {
    error: { status: 400, message: 'Provider returned error' },
  });

  await session.run('do the thing');

  assert.ok(events.some(e => e.type === 'context-full'),
    'the guess has to stay, or llama.cpp overflows get no recovery at all');
});

test('a provider that names the context window is compressed for', async (t) => {
  const { session, events } = await sessionWithHistory(t, {
    error: { status: 400, message: 'request (14231 tokens) exceeds the available context size (13312 tokens)' },
  });

  await session.run('do the thing');

  const contextFull = events.find(e => e.type === 'context-full');
  assert.ok(contextFull, 'an explicit overflow must reach compression');
  assert.equal((contextFull as { compressed: boolean }).compressed, true);
});

// ── connection-error retry ─────────────────────────────────────────────────────
//
// A dropped connection is not the provider saying no — nothing was answered —
// so unlike every error above, it is retried rather than reported or
// compressed for. `connectionRetryBaseMs: 1` keeps these on the order of
// milliseconds instead of waiting out a real multi-second backoff.
//
// Status 400, not the 500+ a real dropped connection would answer with: the
// `openai` client underneath already retries 5xx/408/409/429 itself (default
// `maxRetries: 2`, not something marshall configures), which would silently
// eat these scripted failures before Session's own retry loop ever saw them.
// `classifyProviderError` reads the *message* for `'connection'`, not the
// status, so 400 exercises marshall's own retry in isolation from the SDK's.

test('a dropped connection is retried, silently, and the turn still succeeds', async (t) => {
  const root = tempRoot();
  const fake = await startFakeProvider(
    { error: { status: 400, message: 'terminated' } },
    { text: 'recovered after the retry' },
  );
  t.after(() => fake.close());
  const { client, events } = collector();
  const session = makeSession(root, fake, client, { connectionRetryBaseMs: 1 });
  t.after(() => session.dispose());

  await session.run('do the thing');

  assert.ok(!events.some(e => e.type === 'error'),
    'a connection error that recovers on retry should never reach the client');
  const response = events.find(e => e.type === 'response');
  assert.ok(response, 'the turn should complete once the retry succeeds');
  assert.equal((response as { text: string }).text, 'recovered after the retry');

  assert.equal(fake.requests.length, 2, 'the failed attempt, then one retry');
  const retryMessages = fake.requests[1].messages;
  const lastMessage = retryMessages[retryMessages.length - 1];
  assert.equal(lastMessage.role, 'user',
    'the retry should be a short new turn, not a resend of the original task');
  assert.match(String(lastMessage.content), /dropped before this reply finished/);
});

test('a connection that never recovers is reported once, after retries are exhausted', async (t) => {
  const root = tempRoot();
  const droppedTurn: ScriptedTurn = { error: { status: 400, message: 'terminated' } };
  // maxConnectionRetries: 2 below → 3 attempts total; script exactly that many
  // failures, so a bug that retried past the bound would fall through to
  // EXHAUSTED's plain-text turn and this test would see a false 'response'.
  const fake = await startFakeProvider(droppedTurn, droppedTurn, droppedTurn);
  t.after(() => fake.close());
  const { client, events } = collector();
  const session = makeSession(root, fake, client, { connectionRetryBaseMs: 1, maxConnectionRetries: 2 });
  t.after(() => session.dispose());

  await session.run('do the thing');

  assert.ok(!events.some(e => e.type === 'response'), 'no answer without a single successful attempt');
  const errors = events.filter(e => e.type === 'error');
  assert.equal(errors.length, 1,
    `the exhausted connection error should be reported exactly once: ${JSON.stringify(events.map(e => e.type))}`);
  assert.match((errors[0] as { message: string }).message, /cannot reach/);
  assert.equal(fake.requests.length, 3, 'the initial attempt plus exactly maxConnectionRetries retries');
});

// ── system message resync ───────────────────────────────────────────────────────
//
// The shared History is long-lived and `createAgent` is called fresh every
// turn, but the SDK's own system-message guard only *skips* re-adding when
// the content is byte-identical — it never repositions, so a prompt that
// legitimately changes turn to turn (`/runtime light`, `/runtime agentic`)
// used to leave a stale entry in place and append the new one wherever
// history currently ended. Several providers reject a system message that
// isn't first outright (llama.cpp's Jinja template: "System message must be
// at the beginning") — this is what actually surfaced it.

test('a system prompt that changes mid-session stays first, not duplicated', async (t) => {
  const root = tempRoot();
  const fake = await startFakeProvider(
    { text: 'first answer, default runtime' },
    { text: 'second answer, light runtime' },
  );
  t.after(() => fake.close());
  const { client } = collector();
  const session = makeSession(root, fake, client);
  t.after(() => session.dispose());

  await session.run('do the first thing');
  session.setRuntime('light');
  await session.run('do the second thing');

  assert.equal(fake.requests.length, 2);
  const messages = fake.requests[1].messages;
  const systemMessages = messages.filter(m => m.role === 'system');
  assert.equal(systemMessages.length, 1,
    `exactly one system message, not a stale one plus a new one: ${JSON.stringify(messages.map(m => m.role))}`);
  assert.equal(messages[0].role, 'system', 'the system message must be first, not wherever it landed');
});
