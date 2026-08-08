import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MaxTokensExceededError } from '@agentionai/agents/core';
import type { ApprovalRequest } from '@agentionai/marshall-tools';
import {
  buildSafetyContext, parseSafetyVerdict, runSafetyJudge, createSafetyAgentDecider, describeJudgeFailure,
} from './safety-agent.js';
import { startFakeProvider } from './testing/fake-provider.js';
import type { FakeProvider } from './testing/fake-provider.js';
import type { AgentProfile } from './config.js';

function baseRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    toolName: 'run_shell',
    description: 'Run a shell command',
    detail: 'rm -rf /tmp/scratch',
    input: { command: 'rm -rf /tmp/scratch' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildSafetyContext
// ---------------------------------------------------------------------------

test('buildSafetyContext defaults source to builtin when absent', () => {
  const ctx = buildSafetyContext(baseRequest());
  assert.deepEqual(ctx.source, { kind: 'builtin' });
});

test('buildSafetyContext carries mcp provenance through', () => {
  const ctx = buildSafetyContext(baseRequest({ source: { kind: 'mcp', server: 'github', remoteName: 'delete_repo' } }));
  assert.deepEqual(ctx.source, { kind: 'mcp', server: 'github', remoteName: 'delete_repo' });
});

test('buildSafetyContext carries the task through', () => {
  const ctx = buildSafetyContext(baseRequest({ taskContext: 'delete story.md' }));
  assert.equal(ctx.taskContext, 'delete story.md');
});

test('buildSafetyContext leaves taskContext undefined when no task was given', () => {
  const ctx = buildSafetyContext(baseRequest());
  assert.equal(ctx.taskContext, undefined);
});

test('buildSafetyContext defaults input to an empty object', () => {
  const ctx = buildSafetyContext(baseRequest({ input: undefined }));
  assert.deepEqual(ctx.input, {});
});

// ---------------------------------------------------------------------------
// parseSafetyVerdict
// ---------------------------------------------------------------------------

test('parseSafetyVerdict: chat-judge JSON approve', () => {
  assert.equal(parseSafetyVerdict('{"decision": "approve", "reason": "routine edit"}'), 'approve');
});

test('parseSafetyVerdict: chat-judge JSON deny', () => {
  assert.equal(parseSafetyVerdict('{"decision": "deny", "reason": "deletes outside workspace"}'), 'deny');
});

test('parseSafetyVerdict: nvidia-style JSON safe', () => {
  assert.equal(parseSafetyVerdict('{"User Safety": "safe", "Safety Categories": "none"}'), 'approve');
});

test('parseSafetyVerdict: nvidia-style JSON unsafe', () => {
  assert.equal(parseSafetyVerdict('{"User Safety": "unsafe", "Safety Categories": "O2"}'), 'deny');
});

test('parseSafetyVerdict: JSON wrapped in markdown fences falls back to text scan', () => {
  assert.equal(parseSafetyVerdict('```json\n{"decision": "deny"}\n```'), 'deny');
});

// The plain `User Safety:` / `Response Safety:` line shape these guard models
// actually emit natively (never JSON) — see NVIDIA_SAFETY_SYSTEM_PROMPT.

test('parseSafetyVerdict: plain-line shape, both safe', () => {
  assert.equal(parseSafetyVerdict('User Safety: safe\nResponse Safety: safe'), 'approve');
});

test('parseSafetyVerdict: plain-line shape, Response Safety unsafe denies even if User Safety is safe', () => {
  assert.equal(parseSafetyVerdict('User Safety: safe\nResponse Safety: unsafe\nSafety Categories: O16'), 'deny');
});

test('parseSafetyVerdict: plain-line shape, User Safety unsafe denies even with no Response Safety line', () => {
  // No assistant turn was judged — matches NVIDIA's own documented "omit if no
  // assistant response present" behaviour.
  assert.equal(parseSafetyVerdict('User Safety: unsafe\nSafety Categories: Threat'), 'deny');
});

test('parseSafetyVerdict: plain-line shape is case-insensitive on the field names', () => {
  assert.equal(parseSafetyVerdict('user safety: safe\nresponse safety: safe'), 'approve');
});

test('parseSafetyVerdict: bare "unsafe" text', () => {
  assert.equal(parseSafetyVerdict('unsafe\nO2'), 'deny');
});

test('parseSafetyVerdict: bare "safe" text does not match inside "unsafe"', () => {
  assert.equal(parseSafetyVerdict('This action is unsafe.'), 'deny');
});

test('parseSafetyVerdict: bare "safe" text', () => {
  assert.equal(parseSafetyVerdict('safe'), 'approve');
});

test('parseSafetyVerdict: ambiguous text defers rather than guessing', () => {
  assert.equal(parseSafetyVerdict('I am not sure what this command does.'), 'defer');
});

// ---------------------------------------------------------------------------
// describeJudgeFailure
// ---------------------------------------------------------------------------

test('describeJudgeFailure: a truncated response is reported distinctly from a connectivity failure', () => {
  assert.equal(
    describeJudgeFailure(new MaxTokensExceededError('Response exceeded maximum token limit', 200), 200),
    "judge's response was cut off at the 200-token limit — raise safetyAgent.maxOutputTokens",
  );
});

test('describeJudgeFailure: a real error is reported as unreachable', () => {
  assert.equal(
    describeJudgeFailure(new Error('connect ECONNREFUSED 127.0.0.1:1'), 600),
    'judge unreachable — connect ECONNREFUSED 127.0.0.1:1',
  );
});

test('describeJudgeFailure: a non-Error throw still produces a readable message', () => {
  assert.equal(describeJudgeFailure('not an Error object', 600), 'judge unreachable — not an Error object');
});

// ---------------------------------------------------------------------------
// runSafetyJudge / createSafetyAgentDecider — real HTTP, fake model server
// ---------------------------------------------------------------------------

function profileFor(fake: FakeProvider): AgentProfile {
  return { provider: 'llamacpp', host: fake.host, model: 'safety-test-model' };
}

test('createSafetyAgentDecider: consecutive calls are isolated — no history leaks between tool calls', async (t) => {
  // Directly regression-tests the "is history really transient" question:
  // two calls through the *same* decider, and the second request must be a
  // fresh one-shot that has never seen the first call's tool name or detail.
  const fake = await startFakeProvider(
    { text: '{"decision": "approve", "reason": "first call: read only"}' },
    { text: '{"decision": "deny", "reason": "second call: destructive"}' },
  );
  t.after(() => fake.close());

  const decider = createSafetyAgentDecider({ profile: profileFor(fake), kind: 'chat-judge' });

  await decider(baseRequest({ toolName: 'read_file', detail: 'README.md', input: { path: 'README.md' } }));
  await decider(baseRequest({ toolName: 'run_shell', detail: 'rm -rf /', input: { command: 'rm -rf /' } }));

  assert.equal(fake.requests.length, 2);
  const [first, second] = fake.requests;

  // Each call is a fresh one-shot: system + exactly one user turn, never an
  // accumulating conversation.
  assert.deepEqual(first.messages.map(m => m.role), ['system', 'user']);
  assert.deepEqual(second.messages.map(m => m.role), ['system', 'user']);

  const secondUser = String(second.messages.find(m => m.role === 'user')?.content);
  assert.ok(!secondUser.includes('read_file'), "second call must not see the first call's tool name");
  assert.ok(!secondUser.includes('README.md'), "second call must not see the first call's detail");
  assert.ok(secondUser.includes('run_shell'));
  assert.ok(secondUser.includes('rm -rf /'));
});

test('createSafetyAgentDecider: uses the default 600-token cap when unconfigured', async (t) => {
  const fake = await startFakeProvider({ text: '{"decision": "approve", "reason": "ok"}' });
  t.after(() => fake.close());

  const decider = createSafetyAgentDecider({ profile: profileFor(fake), kind: 'chat-judge' });
  await decider(baseRequest());

  assert.equal(fake.requests[0].body.max_tokens, 600);
});

test('createSafetyAgentDecider: maxOutputTokens overrides the default cap', async (t) => {
  const fake = await startFakeProvider({ text: '{"decision": "approve", "reason": "ok"}' });
  t.after(() => fake.close());

  const decider = createSafetyAgentDecider({ profile: profileFor(fake), kind: 'chat-judge', maxOutputTokens: 1500 });
  await decider(baseRequest());

  assert.equal(fake.requests[0].body.max_tokens, 1500);
});

test('runSafetyJudge: chat-judge kind sends the rendered call and parses an approve', async (t) => {
  const fake = await startFakeProvider({ text: '{"decision": "approve", "reason": "read-only"}' });
  t.after(() => fake.close());

  const context = buildSafetyContext(baseRequest({ toolName: 'read_file', detail: 'apps/cli/src/index.tsx', input: { path: 'apps/cli/src/index.tsx' } }));
  const verdict = await runSafetyJudge(profileFor(fake), 'chat-judge', context);

  assert.equal(verdict.decision, 'approve');
  const [request] = fake.requests;
  const userMessage = request.messages.find(m => m.role === 'user');
  assert.ok(String(userMessage?.content).includes('read_file'));
  assert.ok(String(userMessage?.content).includes('apps/cli/src/index.tsx'));
});

test('runSafetyJudge: the instruction leads the rendered prompt when given', async (t) => {
  const fake = await startFakeProvider({ text: '{"decision": "approve", "reason": "asked for"}' });
  t.after(() => fake.close());

  const context = buildSafetyContext(baseRequest({
    toolName: 'run_shell', detail: '$ rm story.md', input: { command: 'rm story.md' },
    taskContext: 'delete story.md',
  }));
  await runSafetyJudge(profileFor(fake), 'chat-judge', context);

  const userMessage = String(fake.requests[0].messages.find(m => m.role === 'user')?.content);
  assert.match(userMessage, /^Instruction: delete story\.md/, 'the instruction leads, ahead of the tool call itself');
});

test('runSafetyJudge: no Instruction line at all when no task was given', async (t) => {
  const fake = await startFakeProvider({ text: '{"decision": "approve", "reason": "ok"}' });
  t.after(() => fake.close());

  const context = buildSafetyContext(baseRequest({ toolName: 'run_shell', detail: '$ rm story.md', input: { command: 'rm story.md' } }));
  await runSafetyJudge(profileFor(fake), 'chat-judge', context);

  const userMessage = String(fake.requests[0].messages.find(m => m.role === 'user')?.content);
  assert.ok(!userMessage.includes('Instruction:'), 'no fabricated instruction when none was given');
});

test('runSafetyJudge: nvidia-content-safety kind renders the instruction and action as separate User/Agent turns', async (t) => {
  const fake = await startFakeProvider({ text: 'User Safety: safe\nResponse Safety: safe' });
  t.after(() => fake.close());

  const context = buildSafetyContext(baseRequest({
    toolName: 'run_shell', detail: '$ rm story.md', input: { command: 'rm story.md' },
    taskContext: 'delete story.md',
  }));
  await runSafetyJudge(profileFor(fake), 'nvidia-content-safety', context);

  const userMessage = String(fake.requests[0].messages.find(m => m.role === 'user')?.content);
  assert.match(userMessage, /<BEGIN CONVERSATION>/);
  assert.match(userMessage, /User: delete story\.md/);
  assert.match(userMessage, /Agent: [\s\S]*run_shell/);
});

test('runSafetyJudge: nvidia-content-safety kind uses a placeholder User turn when no task was given', async (t) => {
  const fake = await startFakeProvider({ text: 'User Safety: safe\nResponse Safety: safe' });
  t.after(() => fake.close());

  const context = buildSafetyContext(baseRequest({ toolName: 'run_shell', detail: '$ rm story.md', input: { command: 'rm story.md' } }));
  await runSafetyJudge(profileFor(fake), 'nvidia-content-safety', context);

  const userMessage = String(fake.requests[0].messages.find(m => m.role === 'user')?.content);
  assert.match(userMessage, /User: \(no instruction was recorded for this action\)/);
});

test('runSafetyJudge: nvidia-content-safety kind parses an unsafe verdict', async (t) => {
  const fake = await startFakeProvider({ text: '{"User Safety": "unsafe", "Safety Categories": "O2"}' });
  t.after(() => fake.close());

  const context = buildSafetyContext(baseRequest({ toolName: 'read_file', detail: 'read ~/.ssh/id_rsa', input: { path: '~/.ssh/id_rsa' } }));
  const verdict = await runSafetyJudge(profileFor(fake), 'nvidia-content-safety', context);

  assert.equal(verdict.decision, 'deny');
  const [request] = fake.requests;
  const systemMessage = request.messages.find(m => m.role === 'system');
  assert.ok(String(systemMessage?.content).includes('PII/Privacy'));
});

test('createSafetyAgentDecider: a safe verdict approves outright, no annotation, and reports onVerdict', async (t) => {
  const fake = await startFakeProvider({ text: '{"decision": "approve", "reason": "routine test run"}' });
  t.after(() => fake.close());

  const verdicts: unknown[] = [];
  const decider = createSafetyAgentDecider(
    { profile: profileFor(fake), kind: 'chat-judge' },
    { onVerdict: (v) => verdicts.push(v) },
  );
  const req = baseRequest({ toolName: 'run_shell', detail: 'npm test', caller: { role: 'coder', model: 'x/y' } });
  const decision = await decider(req);

  assert.equal(decision, 'approve');
  assert.equal(req.detail, 'npm test'); // untouched

  // 'approve' fires onVerdict too — that is the whole point: a call the human
  // never saw is exactly the one whose review would otherwise be invisible.
  assert.deepEqual(verdicts, [{
    toolName: 'run_shell', outcome: 'approve', reason: 'routine test run', model: `${profileFor(fake).provider}/safety-test-model`, caller: 'coder',
  }]);
});

test('createSafetyAgentDecider: an unsafe verdict defers to the human with an annotated detail (override path), and reports onVerdict', async (t) => {
  const fake = await startFakeProvider({ text: '{"decision": "deny", "reason": "deletes outside the workspace"}' });
  t.after(() => fake.close());

  const verdicts: unknown[] = [];
  const decider = createSafetyAgentDecider(
    { profile: profileFor(fake), kind: 'chat-judge' },
    { onVerdict: (v) => verdicts.push(v) },
  );
  const req = baseRequest({ toolName: 'run_shell', detail: 'rm -rf /' });
  const decision = await decider(req);

  // Not a hard 'deny' — the human still gets asked and can override it.
  assert.equal(decision, 'defer');
  assert.match(req.detail, /UNSAFE/);
  assert.match(req.detail, /rm -rf \//);

  assert.equal(verdicts.length, 1);
  assert.equal((verdicts[0] as { outcome: string }).outcome, 'deny');
  assert.equal((verdicts[0] as { reason: string }).reason, 'deletes outside the workspace');
});

test('createSafetyAgentDecider: nvidia kind approving a safe call, reason falls back to categories', async (t) => {
  const fake = await startFakeProvider({ text: '{"User Safety": "safe", "Safety Categories": "none"}' });
  t.after(() => fake.close());

  const verdicts: unknown[] = [];
  const decider = createSafetyAgentDecider(
    { profile: profileFor(fake), kind: 'nvidia-content-safety' },
    { onVerdict: (v) => verdicts.push(v) },
  );
  const decision = await decider(baseRequest({ toolName: 'read_file', detail: 'README.md', input: { path: 'README.md' } }));

  assert.equal(decision, 'approve');
  // "none" categories is not a useful reason on its own — falls back to the raw text.
  assert.equal((verdicts[0] as { reason: string }).reason, '{"User Safety": "safe", "Safety Categories": "none"}');
});

test('createSafetyAgentDecider: nvidia kind reporting an unsafe category as the reason', async (t) => {
  const fake = await startFakeProvider({ text: '{"User Safety": "unsafe", "Safety Categories": "O2"}' });
  t.after(() => fake.close());

  const verdicts: unknown[] = [];
  const decider = createSafetyAgentDecider(
    { profile: profileFor(fake), kind: 'nvidia-content-safety' },
    { onVerdict: (v) => verdicts.push(v) },
  );
  await decider(baseRequest({ toolName: 'read_file', detail: '~/.ssh/id_rsa', input: { path: '~/.ssh/id_rsa' } }));

  assert.equal((verdicts[0] as { outcome: string }).outcome, 'deny');
  assert.equal((verdicts[0] as { reason: string }).reason, 'O2');
});

test('createSafetyAgentDecider: nvidia kind — the plain-line shape these models actually emit, reason from the Safety Categories line', async (t) => {
  const fake = await startFakeProvider({ text: 'User Safety: safe\nResponse Safety: unsafe\nSafety Categories: O16' });
  t.after(() => fake.close());

  const verdicts: unknown[] = [];
  const decider = createSafetyAgentDecider(
    { profile: profileFor(fake), kind: 'nvidia-content-safety' },
    { onVerdict: (v) => verdicts.push(v) },
  );
  const decision = await decider(baseRequest({ toolName: 'read_file', detail: '~/.ssh/id_rsa', input: { path: '~/.ssh/id_rsa' } }));

  assert.equal(decision, 'defer'); // unsafe still escalates to the human, per createSafetyAgentDecider's contract
  assert.equal((verdicts[0] as { outcome: string }).outcome, 'deny');
  assert.equal((verdicts[0] as { reason: string }).reason, 'O16');
});

test('createSafetyAgentDecider: a provider error defers rather than blocking or crashing, and reports an unclear onVerdict', async () => {
  const verdicts: unknown[] = [];
  const decider = createSafetyAgentDecider(
    { profile: { provider: 'llamacpp', host: 'http://127.0.0.1:1', model: 'unreachable' } },
    { onVerdict: (v) => verdicts.push(v) },
  );
  const decision = await decider(baseRequest());
  assert.equal(decision, 'defer');
  assert.equal(verdicts.length, 1);
  assert.equal((verdicts[0] as { outcome: string }).outcome, 'unclear');
  assert.match((verdicts[0] as { reason: string }).reason, /judge unreachable/);
});

// ---------------------------------------------------------------------------
// session log — full prompt + full raw response, for testing/red-teaming the
// judge, not just a breadcrumb
// ---------------------------------------------------------------------------

test('createSafetyAgentDecider: logs the full system/user prompt and the full raw response, untruncated', async (t) => {
  // Longer than the old 300-char truncation, to prove it is gone.
  const longReason = 'x'.repeat(500);
  const rawResponse = `{"decision": "deny", "reason": "${longReason}"}`;
  const fake = await startFakeProvider({ text: rawResponse });
  t.after(() => fake.close());

  const lines: string[] = [];
  const decider = createSafetyAgentDecider(
    { profile: profileFor(fake), kind: 'chat-judge' },
    { log: (line) => lines.push(line) },
  );
  await decider(baseRequest({ toolName: 'run_shell', detail: 'rm -rf /', input: { command: 'rm -rf /' } }));

  assert.equal(lines.length, 1);
  const [line] = lines;
  assert.match(line, /^SAFETY_AGENT tool=run_shell/);
  assert.match(line, /--- system prompt ---/);
  assert.match(line, /--- user prompt ---/);
  assert.match(line, /--- raw response ---/);
  assert.ok(line.includes('rm -rf /'), 'the user prompt (the rendered call) is in the log');
  assert.ok(line.includes(rawResponse), 'the full, untruncated raw response is in the log');
});

test('createSafetyAgentDecider: logs the prompt even when the judge call fails outright', async () => {
  const lines: string[] = [];
  const decider = createSafetyAgentDecider(
    { profile: { provider: 'llamacpp', host: 'http://127.0.0.1:1', model: 'unreachable' } },
    { log: (line) => lines.push(line) },
  );
  await decider(baseRequest({ toolName: 'run_shell', detail: 'rm -rf /', input: { command: 'rm -rf /' } }));

  assert.equal(lines.length, 1);
  const [line] = lines;
  assert.match(line, /^SAFETY_AGENT_ERROR tool=run_shell/);
  assert.match(line, /--- system prompt ---/);
  assert.match(line, /--- user prompt ---/);
  assert.ok(line.includes('rm -rf /'), "the prompt that was about to be sent is logged even though it never got a response");
});

test('runSafetyJudge: the returned verdict carries the exact prompt that was sent', async (t) => {
  const fake = await startFakeProvider({ text: '{"decision": "approve", "reason": "ok"}' });
  t.after(() => fake.close());

  const context = buildSafetyContext(baseRequest({ toolName: 'write_file', detail: 'notes.md', input: { path: 'notes.md' } }));
  const verdict = await runSafetyJudge(profileFor(fake), 'chat-judge', context);

  assert.match(verdict.systemPrompt, /security reviewer/i);
  assert.ok(verdict.userPrompt.includes('write_file'));
  assert.ok(verdict.userPrompt.includes('notes.md'));
});
