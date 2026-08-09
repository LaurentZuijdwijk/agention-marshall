// ── engine integration: a real turn, end to end ───────────────────────────────
//
// A real Session, the real tool belt, the real openai SDK — only the model
// server is fake (see ../testing/fake-provider.ts). What these cover that the
// unit tests cannot: that a scripted tool call actually reaches the tool, that
// the approval gate sits between the two, and that the events a client renders
// arrive in the order it renders them in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Session } from '../session.js';
import { startFakeProvider } from '../testing/fake-provider.js';
import type { FakeProvider } from '../testing/fake-provider.js';
import type { ClientInterface, OutputEvent, ApprovalRequest, ApprovalDecision } from '../types.js';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'marshall-integration-'));
}

interface Recorder {
  client: ClientInterface;
  events: OutputEvent[];
  approvals: ApprovalRequest[];
  /** Event types in arrival order — what most ordering assertions read. */
  types(): string[];
  text(type: OutputEvent['type']): string[];
}

/** A client that records everything and answers approvals with `decide`. */
function recorder(decide: (req: ApprovalRequest) => ApprovalDecision = () => 'approve'): Recorder {
  const events: OutputEvent[] = [];
  const approvals: ApprovalRequest[] = [];
  return {
    events,
    approvals,
    types: () => events.map(e => e.type),
    text: (type) => events
      .filter(e => e.type === type)
      .map(e => ('text' in e ? e.text : 'message' in e ? e.message : '')),
    client: {
      onOutput: (event) => { events.push(event); },
      requestApproval: async (request) => {
        approvals.push(request);
        return decide(request);
      },
    },
  };
}

/**
 * A session wired to the fake server.
 *
 * `llamacpp` because it is the provider that maps to the OpenAI-compatible
 * agent with a host we control; nothing here is llama.cpp-specific.
 * Compression off — an enabled summariser would create a second agent and make
 * the request log non-deterministic.
 */
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

test('a turn that writes a file: approval gate, tool runs, events in order', async (t) => {
  const root = tempRoot();
  const fake = await startFakeProvider(
    {
      text: 'Creating the file now.',
      toolCalls: [{ name: 'write_file', arguments: { path: 'hello.txt', content: 'hi there' } }],
    },
    { text: 'Done — hello.txt now says "hi there".' },
  );
  t.after(() => fake.close());

  const rec = recorder();
  const session = makeSession(root, fake, rec.client);
  t.after(() => session.dispose());

  await session.run('create hello.txt saying hi there');

  // The gate was consulted, and with the arguments the model actually sent.
  assert.equal(rec.approvals.length, 1, 'write_file is gated, so exactly one approval');
  assert.equal(rec.approvals[0].toolName, 'write_file');
  assert.deepEqual(rec.approvals[0].input, { path: 'hello.txt', content: 'hi there' });
  assert.equal(rec.approvals[0].caller?.role, 'coder');

  // The tool really ran.
  assert.equal(readFileSync(join(root, 'hello.txt'), 'utf8'), 'hi there');

  // And the client saw a renderable turn: work announced before the answer.
  const types = rec.types();
  assert.ok(types.indexOf('tool-call') < types.indexOf('response'),
    `tool call should precede the answer, got ${types.join(' → ')}`);
  assert.deepEqual(rec.text('response'), ['Done — hello.txt now says "hi there".']);
  assert.equal(rec.events.some(e => e.type === 'usage'), true, 'usage is reported for the turn');
  assert.equal(fake.pending, 0, 'the whole script was consumed');
});

test('denying an approval leaves the file alone and tells the model why', async (t) => {
  const root = tempRoot();
  const fake = await startFakeProvider(
    { toolCalls: [{ name: 'write_file', arguments: { path: 'nope.txt', content: 'should not exist' } }] },
    { text: 'Understood — I left it alone.' },
  );
  t.after(() => fake.close());

  const rec = recorder(() => 'deny');
  const session = makeSession(root, fake, rec.client);
  t.after(() => session.dispose());

  await session.run('write nope.txt');

  assert.equal(existsSync(join(root, 'nope.txt')), false, 'a denied write must not touch the disk');

  // The refusal has to reach the model, or it will simply try again.
  const followUp = fake.requests[1];
  const toolResult = followUp.messages.find(m => m.role === 'tool');
  assert.ok(toolResult, 'the second request carries the tool result');
  assert.match(String(toolResult.content), /denied/i,
    `the model should be told it was denied, got: ${JSON.stringify(toolResult.content)}`);
});

// The tool belt is rebuilt per turn, so anything the belt itself owns resets
// between turns. Read tracking must not: reading a file and editing it in the
// *next* turn is the ordinary flow, and when the set was factory-owned this
// failed with "has not been read this session" for a file that had been.
test('a file read in one turn can be edited in the next', async (t) => {
  const root = tempRoot();
  writeFileSync(join(root, 'plan.md'), '# Plan\n\n- [ ] ship it\n');

  const fake = await startFakeProvider(
    { toolCalls: [{ name: 'read_file', arguments: { path: 'plan.md' } }] },
    { text: 'Read it.' },
  );
  t.after(() => fake.close());

  const rec = recorder();
  const session = makeSession(root, fake, rec.client);
  t.after(() => session.dispose());

  await session.run('read plan.md');

  // A second, separate turn — a fresh belt, and the only thing carrying the
  // earlier read forward is the session.
  fake.script(
    { toolCalls: [{ name: 'edit_file', arguments: { path: 'plan.md', oldString: 'ship it', newString: 'shipped' } }] },
    { text: 'Updated.' },
  );
  await session.run('mark it shipped');

  const editResult = fake.requests
    .flatMap(r => r.messages)
    .filter(m => m.role === 'tool')
    .map(m => String(m.content))
    .pop();
  assert.doesNotMatch(String(editResult), /has not been read/,
    `the edit should not demand a re-read, got: ${editResult}`);
  assert.equal(readFileSync(join(root, 'plan.md'), 'utf8'), '# Plan\n\n- [ ] shipped\n');
});

// A model batching several edit_file calls into one assistant message is
// ordinary behaviour, and the SDK runs that batch concurrently. Each edit is a
// read-modify-write, so unserialised they all read the same original and only
// the last write survives — with every call still reporting "Edited".
test('several edits to one file in a single batch all land', async (t) => {
  const root = tempRoot();
  writeFileSync(join(root, 'notes.md'), 'AAA\nBBB\nCCC\n');

  const fake = await startFakeProvider(
    {
      toolCalls: [
        { name: 'read_file', arguments: { path: 'notes.md' } },
      ],
    },
    {
      toolCalls: [
        { name: 'edit_file', arguments: { path: 'notes.md', oldString: 'AAA', newString: 'XXX' } },
        { name: 'edit_file', arguments: { path: 'notes.md', oldString: 'BBB', newString: 'YYY' } },
        { name: 'edit_file', arguments: { path: 'notes.md', oldString: 'CCC', newString: 'ZZZ' } },
      ],
    },
    { text: 'All three applied.' },
  );
  t.after(() => fake.close());

  const rec = recorder();
  const session = makeSession(root, fake, rec.client);
  t.after(() => session.dispose());

  await session.run('replace each marker in notes.md');

  assert.equal(readFileSync(join(root, 'notes.md'), 'utf8'), 'XXX\nYYY\nZZZ\n',
    'every edit in the batch must survive, not just the last writer');

  const toolResults = fake.requests
    .flatMap(r => r.messages)
    .filter(m => m.role === 'tool')
    .map(m => String(m.content));
  assert.equal(toolResults.filter(r => /Edited/.test(r)).length, 3,
    `all three edits should report success, got: ${toolResults.join(' | ')}`);
});

// The write_file counterpart to the batch above, and the one seen in the wild:
// two whole-file writes to plan.md in one batch, both reporting success, the
// second silently discarding the first. Serialising cannot fix this — each
// write carries complete content built from the same read — so the second is
// refused and steered at edit_file instead.
test('two whole-file writes to one path in a batch: the second is refused', async (t) => {
  const root = tempRoot();
  writeFileSync(join(root, 'plan.md'), '# Plan\n');

  const fake = await startFakeProvider(
    { toolCalls: [{ name: 'read_file', arguments: { path: 'plan.md' } }] },
    {
      toolCalls: [
        { name: 'write_file', arguments: { path: 'plan.md', content: '# Plan\n\n- first\n' } },
        { name: 'write_file', arguments: { path: 'plan.md', content: '# Plan\n\n- second\n' } },
      ],
    },
    { text: 'One landed, one was refused.' },
  );
  t.after(() => fake.close());

  const rec = recorder();
  const session = makeSession(root, fake, rec.client);
  t.after(() => session.dispose());

  await session.run('write out the plan');

  assert.equal(readFileSync(join(root, 'plan.md'), 'utf8'), '# Plan\n\n- first\n',
    'the first write must survive rather than being overwritten by the second');

  const results = fake.requests
    .flatMap(r => r.messages)
    .filter(m => m.role === 'tool')
    .map(m => String(m.content));
  assert.equal(results.filter(r => /Wrote/.test(r)).length, 1, `exactly one write succeeds: ${results.join(' | ')}`);
  const refusal = results.find(r => /changed after you read it/.test(r));
  assert.ok(refusal, `the model must be told why, got: ${results.join(' | ')}`);
  assert.match(refusal, /edit_file/, 'and pointed at the tool that composes');
});

// The gate coalesced in-flight requests by tool name, so a batch of writes to
// different files cost exactly one prompt and the rest inherited its answer.
// Every distinct write has to be consented to on its own.
test('a batch of writes to different files asks about each one', async (t) => {
  const root = tempRoot();
  const fake = await startFakeProvider(
    {
      toolCalls: [
        { name: 'write_file', arguments: { path: 'a.txt', content: 'aaa' } },
        { name: 'write_file', arguments: { path: 'b.txt', content: 'bbb' } },
        { name: 'write_file', arguments: { path: 'c.txt', content: 'ccc' } },
      ],
    },
    { text: 'All three written.' },
  );
  t.after(() => fake.close());

  const rec = recorder();
  const session = makeSession(root, fake, rec.client);
  t.after(() => session.dispose());

  await session.run('create three files');

  assert.equal(rec.approvals.length, 3, 'one decision per file, not one for the batch');
  assert.deepEqual(
    rec.approvals.map(r => (r.input as { path: string }).path).sort(),
    ['a.txt', 'b.txt', 'c.txt'],
  );
});

test('denying one write in a batch leaves the others to be decided on their own', async (t) => {
  const root = tempRoot();
  const fake = await startFakeProvider(
    {
      toolCalls: [
        { name: 'write_file', arguments: { path: 'keep.txt', content: 'keep' } },
        { name: 'write_file', arguments: { path: 'drop.txt', content: 'drop' } },
      ],
    },
    { text: 'One written, one refused.' },
  );
  t.after(() => fake.close());

  const rec = recorder((req) => ((req.input as { path: string }).path === 'drop.txt' ? 'deny' : 'approve'));
  const session = makeSession(root, fake, rec.client);
  t.after(() => session.dispose());

  await session.run('create two files');

  assert.equal(readFileSync(join(root, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(existsSync(join(root, 'drop.txt')), false, 'the denied write must not land');
});

test('the model is sent its tools and the task', async (t) => {
  const root = tempRoot();
  const fake = await startFakeProvider({ text: 'ok' });
  t.after(() => fake.close());

  const rec = recorder();
  const session = makeSession(root, fake, rec.client);
  t.after(() => session.dispose());

  await session.run('what can you do?');

  const first = fake.requests[0];
  assert.equal(first.model, 'test-model');
  assert.equal(first.stream, true, 'run() takes the streaming path');
  for (const expected of ['read_file', 'write_file', 'edit_file', 'run_shell', 'search', 'list_dir']) {
    assert.ok(first.tools.includes(expected), `the belt should offer ${expected}, got ${first.tools.join(', ')}`);
  }
  const user = first.messages.filter(m => m.role === 'user').pop();
  assert.match(JSON.stringify(user?.content), /what can you do\?/);
});

// ask_user is offered only when the client can actually surface a question.
// The wiring moved into ToolBelt.forTurn during the session refactor, so this
// pins that the belt still keys off the client rather than always offering a
// tool with nowhere to ask.
test('ask_user is offered only to a client that can ask', async (t) => {
  const root = tempRoot();
  const fake = await startFakeProvider({ text: 'ok' }, { text: 'ok' });
  t.after(() => fake.close());

  const withoutAsk = recorder();
  const plain = makeSession(root, fake, withoutAsk.client);
  await plain.run('hello');
  plain.dispose();
  assert.ok(!fake.requests[0].tools.includes('ask_user'),
    `a client with no askUser must not be offered it, got ${fake.requests[0].tools.join(', ')}`);

  const withAsk = recorder();
  const asking = makeSession(root, fake, { ...withAsk.client, askUser: async () => 'an answer' });
  await asking.run('hello again');
  asking.dispose();
  const offered = fake.requests[fake.requests.length - 1].tools;
  assert.ok(offered.includes('ask_user'), `expected ask_user in the belt, got ${offered.join(', ')}`);
});

test('streamed tokens reach the client as they arrive', async (t) => {
  const root = tempRoot();
  // Long enough that the fake splits it across several SSE chunks — the point
  // is that the client sees pieces, not one lump at the end.
  const answer = 'The quick brown fox jumps over the lazy dog, repeatedly and with feeling.';
  const fake = await startFakeProvider({ text: answer });
  t.after(() => fake.close());

  const rec = recorder();
  const session = makeSession(root, fake, rec.client);
  t.after(() => session.dispose());

  await session.run('say something');

  const tokens = rec.events.filter(e => e.type === 'token');
  assert.ok(tokens.length > 1, `expected several token events, got ${tokens.length}`);
  assert.equal(tokens.map(e => (e as { text: string }).text).join(''), answer,
    'the token stream reassembles into exactly the answer');
});

// The question this answers is not "does history work" but "can Laurent find
// out". A user reporting that the agent forgot the previous answer has, until
// now, had no way to tell a missing history entry from a masked one from a
// model that simply ignored it — the session log records the task and the tool
// calls, never what was sent.
test('MARSHALL_TRACE_HISTORY writes what the model was given, turn by turn', async (t) => {
  const root = tempRoot();
  const fake = await startFakeProvider(
    { text: 'Here is a story about a lighthouse keeper on Skerry Isle.' },
    { text: 'Written to story.md.' },
  );
  t.after(() => fake.close());

  const previous = process.env.MARSHALL_TRACE_HISTORY;
  process.env.MARSHALL_TRACE_HISTORY = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.MARSHALL_TRACE_HISTORY;
    else process.env.MARSHALL_TRACE_HISTORY = previous;
  });

  const session = makeSession(root, fake, recorder().client);
  t.after(() => session.dispose());

  await session.run('write me a short story');
  await session.run('now write it to story.md');
  // The write is fire-and-forget, like every other line in the session log.
  await new Promise(resolve => setTimeout(resolve, 200));

  const path = join(root, '.marshall', 'logs', 'history.log');
  assert.equal(existsSync(path), true, 'tracing was on, so the file should exist');
  const trace = readFileSync(path, 'utf8');

  // The record that matters: what the second task was about to be given.
  const followUp = trace
    .split('\n\n')
    .find(record => record.includes('before "now write it to story.md"'));
  assert.ok(followUp, `no "before" record for the second turn in:\n${trace}`);
  assert.match(followUp, /assistant text\s+Here is a story about a lighthouse keeper on Skerry Isle\./,
    'the follow-up turn has to show the previous answer it depends on');
  assert.match(followUp, /user text\s+write me a short story/);
});

test('history tracing stays off unless it is asked for', async (t) => {
  const root = tempRoot();
  const fake = await startFakeProvider({ text: 'Hello.' });
  t.after(() => fake.close());

  const previous = process.env.MARSHALL_TRACE_HISTORY;
  delete process.env.MARSHALL_TRACE_HISTORY;
  t.after(() => {
    if (previous !== undefined) process.env.MARSHALL_TRACE_HISTORY = previous;
  });

  const session = makeSession(root, fake, recorder().client);
  t.after(() => session.dispose());

  await session.run('say hi');
  await new Promise(resolve => setTimeout(resolve, 200));

  assert.equal(existsSync(join(root, '.marshall', 'logs', 'history.log')), false,
    'a conversation must not be written to disk by default');
});
