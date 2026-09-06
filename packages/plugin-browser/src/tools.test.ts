// Exercised through the real server (startServer) + a real MCP client rather
// than by reaching into McpServer's internals — registerBrowserTools has no
// public per-tool handle to call directly, and the HTTP round trip is what
// integration.e2e.test.ts already proved works cleanly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { MCPClient } from '@agentionai/agents/core';
import { startServer } from './http-server.js';
import { generateToken } from './token.js';
import { MAX_PAGE_TEXT_CHARS } from './tools.js';

async function harness(answers: Record<string, unknown>) {
  const token = generateToken();
  const server = await startServer({ port: 0, token });
  const ext = new WebSocket(`${server.bridgeUrl}?token=${encodeURIComponent(token)}`);
  await new Promise((resolve, reject) => { ext.once('open', resolve); ext.once('error', reject); });
  const seenParams: Record<string, unknown>[] = [];
  ext.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    seenParams.push(msg.params);
    ext.send(JSON.stringify({ id: msg.id, ok: true, result: answers[msg.type] }));
  });

  const client = MCPClient.fromUrl(server.url, { clientName: 'tools-test' });
  await client.connect();

  return {
    seenParams,
    call: (name: string, args: Record<string, unknown> = {}) => {
      const tool = client.getTools().find(t => t.getPrompt().name === name)!;
      return tool.execute('a', 'b', args, 'id') as Promise<string>;
    },
    close: async () => { await client.disconnect(); ext.close(); await server.close(); },
  };
}

test('browser_read_page defaults to markdown format', async (t) => {
  const h = await harness({ read_page: { text: 'hello', url: 'https://x.test', title: 'X' } });
  t.after(h.close);
  await h.call('browser_read_page');
  assert.deepEqual(h.seenParams[0], { format: 'markdown' });
});

test('browser_read_page forwards an explicit text format', async (t) => {
  const h = await harness({ read_page: { text: 'hello' } });
  t.after(h.close);
  await h.call('browser_read_page', { format: 'text' });
  assert.deepEqual(h.seenParams[0], { format: 'text' });
});

test('browser_read_page forwards an explicit html format', async (t) => {
  const h = await harness({ read_page: { text: '<html></html>' } });
  t.after(h.close);
  await h.call('browser_read_page', { format: 'html' });
  assert.deepEqual(h.seenParams[0], { format: 'html' });
});

test('browser_read_page truncates text past the cap with a clear marker', async (t) => {
  const huge = 'x'.repeat(MAX_PAGE_TEXT_CHARS + 5000);
  const h = await harness({ read_page: { text: huge } });
  t.after(h.close);
  const result = await h.call('browser_read_page');
  assert.ok(result.length < huge.length);
  assert.match(result, /truncated at/);
});

test('browser_read_page does not truncate a page under the cap', async (t) => {
  const h = await harness({ read_page: { text: 'short page' } });
  t.after(h.close);
  const result = await h.call('browser_read_page');
  assert.equal(result, 'short page');
});

test('browser_press_key forwards the key, selector and modifiers', async (t) => {
  const h = await harness({ press_key: {} });
  t.after(h.close);
  await h.call('browser_press_key', { key: 'Enter', selector: '#q', ctrlKey: true });
  assert.deepEqual(h.seenParams[0], { key: 'Enter', selector: '#q', ctrlKey: true });
});

test('browser_press_key works with no selector or modifiers', async (t) => {
  const h = await harness({ press_key: {} });
  t.after(h.close);
  const result = await h.call('browser_press_key', { key: 'Escape' });
  assert.match(result, /Pressed "Escape"/);
  assert.doesNotMatch(result, /on "/);
});
