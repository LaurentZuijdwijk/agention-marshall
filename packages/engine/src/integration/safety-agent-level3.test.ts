// ── engine integration: safety level 3, end to end ────────────────────────────
//
// A real Session with two fake model servers: one plays the coder that
// proposes tool calls, the other plays the safety-review model configured via
// `safetyAgent`. Deliberately two different fake "models" with two different
// verdict shapes — one shaped like NVIDIA's guard-model output
// (`{"User Safety": ...}`), one shaped like a general chat-judge
// (`{"decision": ...}`) — to demonstrate that the decider works against
// either configured model, per `SafetyAgentKind`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Session } from '../session.js';
import { startFakeProvider } from '../testing/fake-provider.js';
import type { FakeProvider } from '../testing/fake-provider.js';
import type { ClientInterface, OutputEvent, ApprovalRequest, ApprovalDecision } from '../types.js';
import type { SafetyAgentConfig } from '../config.js';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'marshall-safety-integration-'));
}

interface Recorder {
  client: ClientInterface;
  approvals: ApprovalRequest[];
}

function recorder(decide: (req: ApprovalRequest) => ApprovalDecision = () => 'approve'): Recorder {
  const approvals: ApprovalRequest[] = [];
  return {
    approvals,
    client: {
      onOutput: (_event: OutputEvent) => {},
      requestApproval: async (request) => {
        approvals.push(request);
        return decide(request);
      },
    },
  };
}

function makeSession(
  root: string,
  coder: FakeProvider,
  safetyAgent: SafetyAgentConfig,
  client: ClientInterface,
  safetyLevel: 1 | 2 | 3 = 3,
): Session {
  return new Session(
    {
      agent: { provider: 'llamacpp', host: coder.host, model: 'coder-model' },
      workspaceRoot: root,
      compressionThreshold: 0,
      enableWebSearch: false,
      safetyLevel,
      safetyAgent,
    },
    client,
  );
}

test('level 3, nvidia-content-safety kind: a safe write is approved without asking the human', async (t) => {
  const root = tempRoot();
  const coder = await startFakeProvider(
    { toolCalls: [{ name: 'write_file', arguments: { path: 'hello.txt', content: 'hi there' } }] },
    { text: 'Done.' },
  );
  const guard = await startFakeProvider({ text: '{"User Safety": "safe", "Safety Categories": "none"}' });
  t.after(() => Promise.all([coder.close(), guard.close()]));

  const rec = recorder(() => 'deny'); // if the human is asked at all, force a visible failure
  const session = makeSession(root, coder, { profile: { provider: 'llamacpp', host: guard.host, model: 'guard-model' }, kind: 'nvidia-content-safety' }, rec.client);
  t.after(() => session.dispose());

  await session.run('create hello.txt saying hi there');

  assert.equal(rec.approvals.length, 0, 'a clear safe verdict must not interrupt the human');
  assert.equal(readFileSync(join(root, 'hello.txt'), 'utf8'), 'hi there', 'the write actually ran');

  const guardRequest = guard.requests[0];
  assert.match(String(guardRequest.messages.find(m => m.role === 'system')?.content), /UNSAFE CONTENT CATEGORIES/);
  assert.match(String(guardRequest.messages.find(m => m.role === 'user')?.content), /write_file/);
});

test('level 3, chat-judge kind: an unsafe command still reaches the human, annotated, and can be overridden', async (t) => {
  const root = tempRoot();
  const coder = await startFakeProvider(
    { toolCalls: [{ name: 'run_shell', arguments: { command: 'rm -rf /' } }] },
    { text: 'Done.' },
  );
  const guard = await startFakeProvider({ text: '{"decision": "deny", "reason": "recursively deletes the filesystem root"}' });
  t.after(() => Promise.all([coder.close(), guard.close()]));

  // The human overrides the safety agent's denial.
  const rec = recorder(() => 'approve');
  const session = makeSession(root, coder, { profile: { provider: 'llamacpp', host: guard.host, model: 'judge-model' }, kind: 'chat-judge' }, rec.client);
  t.after(() => session.dispose());

  await session.run('clean everything up');

  assert.equal(rec.approvals.length, 1, 'an unsafe verdict still escalates to the human instead of hard-blocking');
  assert.match(rec.approvals[0].detail, /UNSAFE/i);
  assert.match(rec.approvals[0].detail, /recursively deletes the filesystem root/);
  assert.match(rec.approvals[0].detail, /rm -rf \//, 'the original command detail is preserved alongside the annotation');
});

test('level 3: an unreachable judge defers to the human instead of auto-approving', async (t) => {
  const root = tempRoot();
  const coder = await startFakeProvider(
    { toolCalls: [{ name: 'run_shell', arguments: { command: 'rm -rf /' } }] },
    { text: 'Done.' },
  );
  t.after(() => coder.close());

  // The judge cannot even be reached (dead host). The call must NOT sail
  // through as approved: it defers to the human, who can deny it.
  const rec = recorder(() => 'deny');
  const session = makeSession(
    root, coder,
    { profile: { provider: 'llamacpp', host: 'http://127.0.0.1:1', model: 'judge-unreachable' } },
    rec.client,
  );
  t.after(() => session.dispose());

  await session.run('clean everything up');

  assert.equal(rec.approvals.length, 1, 'an unreachable judge must still escalate to the human');
  assert.match(rec.approvals[0].detail, /rm -rf \//, 'the call detail is preserved for the human to judge');
  assert.doesNotMatch(rec.approvals[0].detail, /UNSAFE/i, 'no false safety annotation from a judge that never answered');
});

test('level 3, chat-judge kind: the human can also confirm the denial', async (t) => {
  const root = tempRoot();
  const coder = await startFakeProvider(
    { toolCalls: [{ name: 'run_shell', arguments: { command: 'rm -rf /' } }] },
    { text: 'Understood — left it alone.' },
  );
  const guard = await startFakeProvider({ text: '{"decision": "deny", "reason": "destructive"}' });
  t.after(() => Promise.all([coder.close(), guard.close()]));

  const rec = recorder(() => 'deny');
  const session = makeSession(root, coder, { profile: { provider: 'llamacpp', host: guard.host, model: 'judge-model' } }, rec.client);
  t.after(() => session.dispose());

  await session.run('clean everything up');

  assert.equal(rec.approvals.length, 1);
  assert.equal(existsSync('/tmp/__should_never_exist__'), false);
});

test('level 1: no gate at all, even without a safety agent configured', async (t) => {
  const root = tempRoot();
  const coder = await startFakeProvider(
    { toolCalls: [{ name: 'write_file', arguments: { path: 'auto.txt', content: 'no gate' } }] },
    { text: 'Done.' },
  );
  t.after(() => coder.close());

  const rec = recorder(() => 'deny'); // would fail the write if consulted
  const session = new Session(
    {
      agent: { provider: 'llamacpp', host: coder.host, model: 'coder-model' },
      workspaceRoot: root,
      compressionThreshold: 0,
      enableWebSearch: false,
      safetyLevel: 1,
    },
    rec.client,
  );
  t.after(() => session.dispose());

  await session.run('create auto.txt');

  assert.equal(rec.approvals.length, 0);
  assert.equal(readFileSync(join(root, 'auto.txt'), 'utf8'), 'no gate');
});

test('level 3: the judge sees the user\'s actual instruction, not just the bare tool call', async (t) => {
  // The gap that motivated adding taskContext: without the instruction, "the
  // user asked for this file to be deleted" and "the agent decided to delete
  // it on its own" render as an identical prompt. This proves the instruction
  // given to session.run() actually reaches the judge model's request.
  const root = tempRoot();
  const coder = await startFakeProvider(
    { toolCalls: [{ name: 'run_shell', arguments: { command: 'rm story.md' } }] },
    { text: 'Deleted.' },
  );
  const guard = await startFakeProvider({ text: '{"decision": "approve", "reason": "explicitly requested"}' });
  t.after(() => Promise.all([coder.close(), guard.close()]));

  const rec = recorder();
  const session = makeSession(root, coder, { profile: { provider: 'llamacpp', host: guard.host, model: 'judge-model' }, kind: 'chat-judge' }, rec.client);
  t.after(() => session.dispose());

  await session.run('delete story.md');

  const guardRequest = guard.requests[0];
  const userMessage = String(guardRequest.messages.find(m => m.role === 'user')?.content);
  assert.match(userMessage, /^Instruction: delete story\.md/);
});
