import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpRegistry } from './mcp.js';

/** Nothing is listening on port 1, so connecting fails fast and for real —
 *  a stubbed client would prove the stub degrades gracefully, not the code. */
const DEAD_URL = 'http://127.0.0.1:1/mcp';

const toolConfig = { workspaceRoot: '/tmp', approval: async () => 'approve' as const };

test('an empty registry reports itself as empty and offers no tools', () => {
  const registry = new McpRegistry();
  assert.equal(registry.isEmpty, true);
  assert.deepEqual(registry.state(), []);
  assert.deepEqual(registry.tools(toolConfig), []);
});

test('an unreachable server becomes an error state rather than throwing', async () => {
  const registry = new McpRegistry([{ name: 'dead', url: DEAD_URL }]);
  await registry.connectAll();

  const [state] = registry.state();
  assert.equal(state.status, 'error');
  assert.ok(state.error, 'the failure should be reported, not swallowed');
  assert.deepEqual(state.toolNames, []);
});

test('a failed server contributes no tools to the belt', async () => {
  const registry = new McpRegistry([{ name: 'dead', url: DEAD_URL }]);
  await registry.connectAll();
  assert.deepEqual(registry.tools(toolConfig), []);
});

test('a disabled server is never connected', async () => {
  const registry = new McpRegistry([{ name: 'off', url: DEAD_URL, enabled: false }]);
  await registry.connectAll();
  assert.equal(registry.state()[0].status, 'disabled');
});

test('ready() settles even when every server fails', async () => {
  const registry = new McpRegistry([
    { name: 'a', url: DEAD_URL },
    { name: 'b', url: DEAD_URL },
  ]);
  await registry.connectAll();
  await registry.ready();
  assert.deepEqual(registry.state().map(s => s.status), ['error', 'error']);
});

test('add reports the outcome instead of leaving the caller guessing', async () => {
  const registry = new McpRegistry();
  const state = await registry.add({ name: 'dead', url: DEAD_URL });
  assert.equal(state.name, 'dead');
  assert.equal(state.status, 'error');
  assert.equal(registry.isEmpty, false);
});

test('adding the same name twice replaces rather than duplicates', async () => {
  const registry = new McpRegistry();
  await registry.add({ name: 'x', url: DEAD_URL });
  await registry.add({ name: 'x', url: 'http://127.0.0.1:2/mcp' });
  assert.equal(registry.state().length, 1);
  assert.equal(registry.state()[0].url, 'http://127.0.0.1:2/mcp');
});

test('remove reports whether anything was there', async () => {
  const registry = new McpRegistry([{ name: 'dead', url: DEAD_URL }]);
  assert.equal(await registry.remove('dead'), true);
  assert.equal(await registry.remove('dead'), false);
  assert.equal(registry.isEmpty, true);
});

test('reconnect returns null for a server that is not configured', async () => {
  const registry = new McpRegistry();
  assert.equal(await registry.reconnect('nope'), null);
});

test('reconnect retries a failed server', async () => {
  const registry = new McpRegistry([{ name: 'dead', url: DEAD_URL }]);
  await registry.connectAll();
  const state = await registry.reconnect('dead');
  assert.equal(state?.status, 'error');
});

test('configs round-trip what was passed in', () => {
  const registry = new McpRegistry([{ name: 'a', url: DEAD_URL, headers: { Authorization: 'Bearer x' } }]);
  assert.deepEqual(registry.configs, [
    { name: 'a', url: DEAD_URL, headers: { Authorization: 'Bearer x' } },
  ]);
});

test('disconnect is safe on a registry that never connected', async () => {
  const registry = new McpRegistry([{ name: 'dead', url: DEAD_URL }]);
  await registry.disconnect();
  assert.equal(registry.has('dead'), true);
});
