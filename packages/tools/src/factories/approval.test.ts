import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withApproval } from './approval.js';
import type { ApprovalFn, ToolSpec } from '../types.js';

const dummySpec = (executeFn: (input: Record<string, unknown>) => Promise<string>): ToolSpec => ({
  name: 'test_tool',
  description: 'a test tool',
  inputSchema: { type: 'object', properties: {}, required: [] },
  execute: executeFn,
});

const alwaysApprove: ApprovalFn = async () => 'approve';
const alwaysDeny: ApprovalFn = async () => 'deny';
const buildReq = () => ({ toolName: 'test_tool', description: 'test', detail: '' });

test('calls execute when approved', async () => {
  let called = false;
  const tool = withApproval(
    dummySpec(async () => { called = true; return 'done'; }),
    alwaysApprove,
    buildReq,
  );

  const result = await tool.execute('a', 'b', {}, 'id');
  assert.ok(called, 'execute should have been called');
  assert.equal(result, 'done');
});

test('blocks execute when denied', async () => {
  let called = false;
  const tool = withApproval(
    dummySpec(async () => { called = true; return 'done'; }),
    alwaysDeny,
    buildReq,
  );

  const result = await tool.execute('a', 'b', {}, 'id');
  assert.ok(!called, 'execute must not be called when denied');
  assert.match(result, /denied/i);
  assert.match(result, /do not retry/i);
});

test('passes input to execute', async () => {
  let received: Record<string, unknown> = {};
  const tool = withApproval(
    dummySpec(async (input) => { received = input as Record<string, unknown>; return 'ok'; }),
    alwaysApprove,
    buildReq,
  );

  await tool.execute('a', 'b', { key: 'value' }, 'id');
  assert.equal(received.key, 'value');
});

test('calls approval with the built request', async () => {
  let capturedRequest: unknown;
  const approval: ApprovalFn = async (req) => { capturedRequest = req; return 'approve'; };

  const tool = withApproval(
    dummySpec(async () => 'ok'),
    approval,
    (input) => ({ toolName: 'test_tool', description: `run ${input.cmd}`, detail: String(input.cmd) }),
  );

  await tool.execute('a', 'b', { cmd: 'ls' }, 'id');
  // `input` rides along on every request, whatever buildRequest returned: the
  // rendered `detail` is for a human, and a programmatic decider needs the
  // arguments themselves.
  assert.deepEqual(capturedRequest, {
    toolName: 'test_tool', description: 'run ls', detail: 'ls', input: { cmd: 'ls' },
  });
});

test('names the requesting agent on the approval request', async () => {
  let capturedRequest: unknown;
  const approval: ApprovalFn = async (req) => { capturedRequest = req; return 'approve'; };

  const tool = withApproval(
    dummySpec(async () => 'ok'),
    approval,
    buildReq,
    undefined,
    { role: 'coder', model: 'claude/claude-opus-4-6' },
  );

  await tool.execute('a', 'b', {}, 'id');
  assert.deepEqual(capturedRequest, {
    toolName: 'test_tool', description: 'test', detail: '', input: {},
    caller: { role: 'coder', model: 'claude/claude-opus-4-6' },
  });
});

test('omits the caller entirely when the belt has no owner', async () => {
  // An absent field, not `caller: undefined` — the panel decides what to render
  // by presence, so a key that exists but holds nothing would be a lie.
  let capturedRequest: Record<string, unknown> = {};
  const approval: ApprovalFn = async (req) => { capturedRequest = req as unknown as Record<string, unknown>; return 'approve'; };

  const tool = withApproval(dummySpec(async () => 'ok'), approval, buildReq);
  await tool.execute('a', 'b', {}, 'id');
  assert.ok(!('caller' in capturedRequest));
});
