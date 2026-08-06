// ── engine integration: a real turn, end to end ───────────────────────────────
//
// A real Session, the real tool belt, the real openai SDK — only the model
// server is fake (see ../testing/fake-provider.ts). What these cover that the
// unit tests cannot: that a scripted tool call actually reaches the tool, that
// the approval gate sits between the two, and that the events a client renders
// arrive in the order it renders them in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
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
