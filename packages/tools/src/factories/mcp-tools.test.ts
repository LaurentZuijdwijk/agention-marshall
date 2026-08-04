import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tool } from '@agentionai/agents/core';
import { adaptMcpTools, namespaceMcpTool, stringifyResult } from './mcp-tools.js';
import type { ToolConfig, ApprovalRequest } from '../types.js';

/** Stands in for what MCPClient.getTools() hands back — same class, same shape. */
function remoteTool(
  execute: (input: Record<string, unknown>) => Promise<unknown>,
  name = 'create_issue',
): Tool<unknown> {
  return new Tool<unknown>({
    name,
    description: 'Create an issue',
    inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    execute: execute as (input: unknown) => Promise<unknown>,
  });
}

function config(overrides: Partial<ToolConfig> = {}): ToolConfig {
  return { workspaceRoot: '/tmp', approval: async () => 'approve', ...overrides };
}

const call = (tool: Tool<string>, input: Record<string, unknown> = { title: 'x' }) =>
  tool.execute('a', 'b', input, 'id');

test('namespaces tool names so a server cannot shadow a builtin', () => {
  assert.equal(namespaceMcpTool('linear', 'read_file'), 'mcp__linear__read_file');
});

test('sanitises a server name that is not identifier-safe', () => {
  assert.equal(namespaceMcpTool('my server.io', 'ping'), 'mcp__my_server_io__ping');
});

test('adapted tools carry the namespaced name and name their server', () => {
  const [tool] = adaptMcpTools([remoteTool(async () => 'ok')], config(), { server: 'linear' });
  assert.equal(tool.name, 'mcp__linear__create_issue');
  assert.match(tool.getPrompt().description, /via linear MCP server/);
  assert.deepEqual(tool.getPrompt().input_schema.required, ['title']);
});

test('passes the arguments through to the remote tool', async () => {
  const seen: unknown[] = [];
  const [tool] = adaptMcpTools(
    [remoteTool(async (input) => { seen.push(input); return 'done'; })],
    config(),
    { server: 'linear' },
  );
  assert.equal(await call(tool, { title: 'Fix the bug' }), 'done');
  assert.deepEqual(seen, [{ title: 'Fix the bug' }]);
});

// The three contract violations this adapter exists to fix.

test('a throwing remote tool becomes a message, not an exception', async () => {
  const [tool] = adaptMcpTools(
    [remoteTool(async () => { throw new Error('server exploded'); })],
    config(),
    { server: 'linear' },
  );
  const result = await call(tool);
  assert.match(result, /failed/);
  assert.match(result, /server exploded/);
  assert.match(result, /create_issue/);
});

test('a structured result is stringified rather than rendered as [object Object]', async () => {
  const [tool] = adaptMcpTools(
    [remoteTool(async () => ({ id: 42, state: 'open' }))],
    config(),
    { server: 'linear' },
  );
  const result = await call(tool);
  assert.doesNotMatch(result, /\[object Object\]/);
  assert.match(result, /"id": 42/);
});

test('a hung remote tool gives up instead of blocking the turn forever', async () => {
  const [tool] = adaptMcpTools(
    [remoteTool(() => new Promise(() => {}))], // never settles
    config(),
    { server: 'linear', timeoutMs: 50 },
  );
  const result = await call(tool);
  assert.match(result, /timed out/);
});

test('an interrupt stops the wait on a hung remote tool', async () => {
  const controller = new AbortController();
  const [tool] = adaptMcpTools(
    [remoteTool(() => new Promise(() => {}))],
    config({ signal: controller.signal }),
    { server: 'linear', timeoutMs: 60_000 },
  );
  const pending = call(tool);
  setTimeout(() => controller.abort(), 20);
  assert.match(await pending, /interrupted/);
});

test('an already-aborted task does not call the server at all', async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const [tool] = adaptMcpTools(
    [remoteTool(async () => { called = true; return 'ok'; })],
    config({ signal: controller.signal }),
    { server: 'linear' },
  );
  await call(tool);
  assert.equal(called, false);
});

// Approval.

test('every MCP tool goes through the approval gate', async () => {
  const seen: ApprovalRequest[] = [];
  const [tool] = adaptMcpTools([remoteTool(async () => 'ok')], config({
    approval: async (req) => { seen.push(req); return 'approve'; },
  }), { server: 'linear' });

  await call(tool, { title: 'Fix the bug' });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].source, { kind: 'mcp', server: 'linear', remoteName: 'create_issue' });
  assert.deepEqual(seen[0].input, { title: 'Fix the bug' });
  assert.match(seen[0].detail, /Fix the bug/);
});

test('denial stops the call from reaching the server', async () => {
  let called = false;
  const [tool] = adaptMcpTools(
    [remoteTool(async () => { called = true; return 'ok'; })],
    config({ approval: async () => 'deny' }),
    { server: 'linear' },
  );
  const result = await call(tool);
  assert.equal(called, false);
  assert.match(result, /denied/i);
});

test('stringifyResult leaves strings alone and names an empty result', () => {
  assert.equal(stringifyResult('plain'), 'plain');
  assert.equal(stringifyResult(null), '(no result)');
  assert.equal(stringifyResult(undefined), '(no result)');
});

test('stringifyResult survives a circular structure', () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(typeof stringifyResult(circular), 'string');
});
