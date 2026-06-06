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
  assert.deepEqual(capturedRequest, { toolName: 'test_tool', description: 'run ls', detail: 'ls' });
});
