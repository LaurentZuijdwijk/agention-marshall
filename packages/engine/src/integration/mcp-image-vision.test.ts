// ── engine integration: an MCP screenshot reaches the model as vision ────────
//
// `ToolConfig.attachImages` (packages/tools) exists because a tool_result's
// `content` is a plain string in the underlying library — an image cannot
// ride inside it. This proves the whole path end to end, through a real MCP
// server (not a stub of adaptMcpTools): the agent calls a tool that returns
// an MCP image content block, and the *next* request sent to the model
// carries that image as a real content part — not a wall of base64 text, and
// not silently dropped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { Session } from '../session.js';
import { startFakeProvider } from '../testing/fake-provider.js';
import type { FakeProvider } from '../testing/fake-provider.js';
import type { ClientInterface, EngineConfig } from '../index.js';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'marshall-vision-'));
}

const silentClient: ClientInterface = {
  onOutput: () => {},
  requestApproval: async () => 'approve',
};

/** Base64 for a 1x1 PNG — content is irrelevant, only that it round-trips. */
const FAKE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

/**
 * A tiny local MCP server with one tool that returns a text + image result.
 *
 * A fresh `McpServer`/`StreamableHTTPServerTransport` pair per request —
 * stateless mode (`sessionIdGenerator: undefined`) does not support reusing
 * one transport instance across independent HTTP requests, confirmed by
 * hand: reusing a single instance answers the second request (the
 * `notifications/initialized` that follows every `initialize`) with an
 * empty 500. A fresh pair per request is also the SDK's own documented
 * pattern for stateless serving.
 */
async function startScreenshotServer(): Promise<{ url: string; close: () => Promise<void> }> {
  function buildServer(): McpServer {
    const mcpServer = new McpServer({ name: 'test-browser', version: '1.0.0' });
    mcpServer.registerTool(
      'screenshot',
      { description: 'Capture the active tab', inputSchema: {} },
      async () => ({
        content: [
          { type: 'text' as const, text: 'Captured https://example.com' },
          { type: 'image' as const, data: FAKE_PNG, mimeType: 'image/png' },
        ],
      }),
    );
    return mcpServer;
  }

  const app = createMcpExpressApp();
  // express ships no types of its own here (no @types/express in this repo),
  // so the handler is typed against what `transport.handleRequest` actually
  // wants — the Node primitives Express's req/res are built on.
  app.post('/mcp', async (req: IncomingMessage & { body?: unknown }, res: ServerResponse) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const mcpServer = buildServer();
    res.on('close', () => { transport.close(); mcpServer.close(); });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

function makeSession(root: string, fake: FakeProvider, mcpUrl: string): Session {
  return new Session(
    {
      agent: { provider: 'llamacpp', host: fake.host, model: 'test-model' },
      workspaceRoot: root,
      compressionThreshold: 0,
      enableWebSearch: false,
      models: {
        deep: { provider: 'llamacpp', host: fake.host, model: 'test-model' },
        fast: { provider: 'llamacpp', host: fake.host, model: 'small-model' },
      },
      mcpServers: [{ name: 'browser', url: mcpUrl }],
    } satisfies EngineConfig,
    silentClient,
  );
}

test('a screenshot from an MCP tool reaches the model as vision, not text', async (t) => {
  const root = tempRoot();
  const mcp = await startScreenshotServer();
  t.after(() => mcp.close());
  const fake = await startFakeProvider(
    { toolCalls: [{ name: 'mcp__browser__screenshot', arguments: {} }] },
    { text: 'The page shows a placeholder image.' },
  );
  t.after(() => fake.close());
  const session = makeSession(root, fake, mcp.url);
  t.after(() => session.dispose());

  await session.run('take a screenshot');

  assert.equal(fake.requests.length, 2, 'the tool call should trigger a second turn');
  const followUp = fake.requests[1];

  // Every message anywhere in the follow-up request whose content is an array
  // of parts (not a single tool_result string) is a candidate for the
  // synthetic image message `attachImages` appended via history.addMessage.
  const imageParts = followUp.messages
    .flatMap(m => (Array.isArray(m.content) ? m.content : []))
    .filter((part: any) => part?.type === 'image_url' || part?.type === 'input_image' || part?.type === 'image');

  assert.ok(imageParts.length > 0, `expected an image content part in the follow-up request, got messages: ${JSON.stringify(followUp.messages)}`);

  // And the tool_result text itself should say the image was attached, not
  // carry the raw base64.
  const toolResult = followUp.messages.find(m => m.tool_call_id !== undefined);
  const toolResultText = typeof toolResult?.content === 'string' ? toolResult.content : JSON.stringify(toolResult?.content);
  assert.match(String(toolResultText), /attached above/);
  assert.doesNotMatch(String(toolResultText), new RegExp(FAKE_PNG));
});
