// ── engine integration: a tool's screenshot rejected by the provider ─────────
//
// The sibling of image-rejected.test.ts, for the door that file does not
// cover. That one attaches an image to the *task*, which `run()` receives as
// its `images` argument; this one has an MCP tool return the screenshot, so
// the image reaches history through `ToolConfig.attachImages` instead and
// `images` is empty for the whole turn.
//
// That difference is the bug this file exists for. `classifyProviderError`'s
// `hasImages` gate used to be fed `images.length > 0` alone, so a llama.cpp
// model with no mmproj loaded rejected the follow-up request, the rejection
// classified as `other`, and the synthetic image entry stayed in history —
// making every later turn fail the same way, including the "continue" a user
// would naturally type next.
//
// Driven through the real MCP server and the fake HTTP provider for the same
// reason mcp-image-vision.test.ts is: the classification being tested is a
// reading of a real provider response, so a mocked one proves nothing.

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
import type { ClientInterface, EngineConfig, OutputEvent } from '../index.js';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'marshall-mcp-image-rejected-'));
}

const FAKE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

/**
 * The wording llama.cpp actually answers with, and the status it actually
 * uses — a 500, not the 400 the task-attachment tests use.
 *
 * The status is load-bearing: `isBadRequestError` only reads a 400, so a 500
 * never reaches the `maybe-context` fallback. Before the fix this landed on
 * `other`, which reports the raw provider text and offers nothing.
 */
const MMPROJ_ERROR = 'image input is not supported - hint: if this is unexpected, you may need to provide the mmproj';

/**
 * The rejection, scripted as many times as it takes to actually surface.
 *
 * The `openai` client underneath retries 5xx itself (default `maxRetries: 2`
 * — see the connection-retry test in session-lifecycle.test.ts), and the fake
 * provider shifts one scripted turn per HTTP request, so a single scripted
 * error is consumed by the SDK's first retry and the turn goes on to read the
 * *next* script entry. llama.cpp with no mmproj rejects every attempt, not
 * one, so three copies is what reproduces it rather than a workaround.
 */
const REJECTS_EVERY_ATTEMPT = Array.from(
  { length: 3 },
  () => ({ error: { status: 500, message: MMPROJ_ERROR } }),
);

/** Same stateless-per-request shape as mcp-image-vision.test.ts — see its comment. */
async function startScreenshotServer(): Promise<{ url: string; close: () => Promise<void> }> {
  function buildServer(): McpServer {
    const mcpServer = new McpServer({ name: 'test-browser', version: '1.0.0' });
    mcpServer.registerTool(
      'screenshot',
      { description: 'Capture the active tab', inputSchema: {} },
      async () => ({
        content: [
          { type: 'text' as const, text: 'Captured the active tab' },
          { type: 'image' as const, data: FAKE_PNG, mimeType: 'image/png' },
        ],
      }),
    );
    return mcpServer;
  }

  const app = createMcpExpressApp();
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

function makeSession(root: string, fake: FakeProvider, mcpUrl: string, client: ClientInterface): Session {
  return new Session(
    {
      agent: { provider: 'llamacpp', host: fake.host, model: 'test-model' },
      workspaceRoot: root,
      compressionThreshold: 0,
      enableWebSearch: false,
      mcpServers: [{ name: 'browser', url: mcpUrl }],
    } satisfies EngineConfig,
    client,
  );
}

function makeClient(events: OutputEvent[]): ClientInterface {
  return {
    onOutput: (event) => { events.push(event); },
    requestApproval: async () => 'approve',
  };
}

/** Every image content part anywhere in a recorded request. */
function imagePartsIn(request: { messages: Array<{ content?: unknown }> }): unknown[] {
  return request.messages
    .flatMap(m => (Array.isArray(m.content) ? m.content : []))
    .filter((part: any) => part?.type === 'image_url' || part?.type === 'input_image' || part?.type === 'image');
}

test('a screenshot the provider rejects fires image-rejected, not the generic error', async (t) => {
  const root = tempRoot();
  const mcp = await startScreenshotServer();
  t.after(() => mcp.close());
  const fake = await startFakeProvider(
    { toolCalls: [{ name: 'mcp__browser__screenshot', arguments: {} }] },
    ...REJECTS_EVERY_ATTEMPT,
  );
  t.after(() => fake.close());

  const events: OutputEvent[] = [];
  const session = makeSession(root, fake, mcp.url, makeClient(events));
  t.after(() => session.dispose());

  await session.run('check the pagoda renders');

  const rejected = events.filter(e => e.type === 'image-rejected');
  assert.equal(
    rejected.length, 1,
    `expected one image-rejected event, got ${JSON.stringify(events.map(e => e.type))}`,
  );
  assert.match(rejected[0].message, /mmproj/);
  assert.equal(events.filter(e => e.type === 'error').length, 0, 'the generic error event must not also fire');
});

test('the rejected screenshot leaves history, so the next turn is not the same request again', async (t) => {
  const root = tempRoot();
  const mcp = await startScreenshotServer();
  t.after(() => mcp.close());
  const fake = await startFakeProvider(
    { toolCalls: [{ name: 'mcp__browser__screenshot', arguments: {} }] },
    ...REJECTS_EVERY_ATTEMPT,
    { text: 'it renders fine' },
  );
  t.after(() => fake.close());

  const events: OutputEvent[] = [];
  const session = makeSession(root, fake, mcp.url, makeClient(events));
  t.after(() => session.dispose());

  await session.run('check the pagoda renders');
  assert.ok(imagePartsIn(fake.requests[1]).length > 0, 'the rejected request should have carried the image');

  // What the user types after seeing the failure. Before the fix this resent
  // the same synthetic image entry and failed identically, forever.
  await session.run('cont');

  const followUp = fake.requests.at(-1)!;
  assert.equal(
    imagePartsIn(followUp).length, 0,
    `the image must be gone from history, got ${JSON.stringify(followUp.messages)}`,
  );
  assert.equal(events.filter(e => e.type === 'error').length, 0, 'the follow-up turn must not fail');
  assert.ok(
    events.some(e => e.type === 'response' && e.text.includes('it renders fine')),
    'the follow-up turn should have produced an answer',
  );
});

test('after a rejection, a further screenshot is described in text instead of attached', async (t) => {
  const root = tempRoot();
  const mcp = await startScreenshotServer();
  t.after(() => mcp.close());
  const fake = await startFakeProvider(
    { toolCalls: [{ name: 'mcp__browser__screenshot', arguments: {} }] },
    ...REJECTS_EVERY_ATTEMPT,
    // The second turn takes another screenshot — the model has no way to know
    // the first one was unreadable unless the tool result says so.
    { toolCalls: [{ name: 'mcp__browser__screenshot', arguments: {} }] },
    { text: 'I cannot see the page; describing from the text instead.' },
  );
  t.after(() => fake.close());

  const events: OutputEvent[] = [];
  const session = makeSession(root, fake, mcp.url, makeClient(events));
  t.after(() => session.dispose());

  await session.run('check the pagoda renders');
  await session.run('try again');

  const followUp = fake.requests.at(-1)!;
  assert.equal(
    imagePartsIn(followUp).length, 0,
    'the second screenshot must not be attached either, now that the model is known to reject images',
  );

  const toolResults = followUp.messages.filter((m: any) => m.tool_call_id !== undefined);
  const text = toolResults.map((m: any) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
  assert.match(text, /could not be shown to this model/);
  assert.match(text, /rejected an image earlier in the session/);
  // The tool's own text still has to survive: the point of degrading rather
  // than dropping is that the model still learns the screenshot happened.
  assert.match(text, /Captured the active tab/);
  assert.doesNotMatch(text, new RegExp(FAKE_PNG));
});
