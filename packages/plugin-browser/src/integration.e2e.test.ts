import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { MCPClient } from '@agentionai/agents/core';
import { startServer } from './http-server.js';
import { generateToken } from './token.js';

test('a real MCP client can list and call browser tools through a fake extension', async (t) => {
  const token = generateToken();
  const server = await startServer({ port: 0, token });
  t.after(() => server.close());

  const ext = new WebSocket(`${server.bridgeUrl}?token=${encodeURIComponent(token)}`);
  await new Promise((resolve, reject) => { ext.once('open', resolve); ext.once('error', reject); });
  t.after(() => ext.close());
  ext.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'screenshot') {
      ext.send(JSON.stringify({ id: msg.id, ok: true, result: { data: 'ZmFrZQ==', mimeType: 'image/png', url: 'https://example.com', title: 'Example' } }));
    } else {
      ext.send(JSON.stringify({ id: msg.id, ok: true, result: {} }));
    }
  });

  // formatResult: identity — proving *this server* emits a proper
  // CallToolResult with an image block is this test's job; what the engine
  // does with that raw result is covered by
  // packages/engine/src/integration/mcp-image-vision.test.ts.
  const client = MCPClient.fromUrl(server.url, { clientName: 'e2e-test', formatResult: (r) => r });
  await client.connect();
  t.after(() => client.disconnect());

  const tools = client.getTools().map(tool => tool.getPrompt().name);
  assert.deepEqual(tools.sort(), [
    'browser_click', 'browser_console_logs', 'browser_navigate',
    'browser_read_page', 'browser_screenshot', 'browser_type',
  ]);

  const screenshotTool = client.getTools().find(t2 => t2.getPrompt().name === 'browser_screenshot')!;
  const result = await screenshotTool.execute('a', 'b', {}, 'id1') as { content: { type: string; data?: string; mimeType?: string; text?: string }[] };
  const image = result.content.find(c => c.type === 'image');
  assert.equal(image?.data, 'ZmFrZQ==');
  assert.equal(image?.mimeType, 'image/png');
});
