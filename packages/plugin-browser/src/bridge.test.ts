import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { ExtensionBridge } from './bridge.js';
import { generateToken } from './token.js';

/** A bare HTTP server whose only job is the `/bridge` upgrade, matching how
 *  http-server.ts wires it in the real package. */
async function harness(token: string): Promise<{ bridge: ExtensionBridge; url: string; close: () => Promise<void> }> {
  const bridge = new ExtensionBridge(token);
  const server = createServer();
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '', 'http://localhost').pathname === '/bridge') {
      bridge.handleUpgrade(req, socket, head);
    } else {
      socket.destroy();
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    bridge,
    url: `ws://127.0.0.1:${port}/bridge`,
    close: () => new Promise<void>((resolve) => {
      bridge.close();
      (server as Server).close(() => resolve());
    }),
  };
}

function connectClient(url: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

test('a call before any extension connects rejects immediately, no hang', async () => {
  const token = generateToken();
  const { bridge, close } = await harness(token);
  await assert.rejects(bridge.call('navigate', { url: 'https://example.com' }), /no browser extension connected/);
  await close();
});

test('a connection with the wrong token is refused', async () => {
  const token = generateToken();
  const { url, close } = await harness(token);
  await assert.rejects(connectClient(url, 'wrong-token'));
  await close();
});

test('the extension answering a call resolves it with the result', async (t) => {
  const token = generateToken();
  const { bridge, url, close } = await harness(token);
  t.after(close);
  const client = await connectClient(url, token);
  t.after(() => client.close());

  client.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    client.send(JSON.stringify({ id: msg.id, ok: true, result: { screenshot: 'base64...' } }));
  });

  const result = await bridge.call('screenshot', {});
  assert.deepEqual(result, { screenshot: 'base64...' });
});

test('the extension reporting an error rejects the call with that message', async (t) => {
  const token = generateToken();
  const { bridge, url, close } = await harness(token);
  t.after(close);
  const client = await connectClient(url, token);
  t.after(() => client.close());

  client.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    client.send(JSON.stringify({ id: msg.id, ok: false, error: 'no element matches selector' }));
  });

  await assert.rejects(bridge.call('click', { selector: '#missing' }), /no element matches selector/);
});

test('a call that gets no response times out rather than hanging forever', async (t) => {
  const token = generateToken();
  const { bridge, url, close } = await harness(token);
  t.after(close);
  const client = await connectClient(url, token);
  t.after(() => client.close());
  // Never respond.

  await assert.rejects(bridge.call('read_page', {}, 30), /did not respond within/);
});

test('a second connection replaces the first, and the belt reports connected', async (t) => {
  const token = generateToken();
  const { bridge, url, close } = await harness(token);
  t.after(close);
  const first = await connectClient(url, token);
  assert.equal(bridge.connected, true);

  const second = await connectClient(url, token);
  t.after(() => second.close());
  await new Promise(resolve => setTimeout(resolve, 20)); // let the close propagate
  assert.equal(first.readyState, WebSocket.CLOSED);
  assert.equal(bridge.connected, true);
});

test('malformed messages from the extension are ignored, not thrown', async (t) => {
  const token = generateToken();
  const { bridge, url, close } = await harness(token);
  t.after(close);
  const client = await connectClient(url, token);
  t.after(() => client.close());

  client.send('not json');
  client.send(JSON.stringify({ ok: true })); // no id
  // The bridge should still be usable afterwards.
  client.removeAllListeners('message');
  client.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    client.send(JSON.stringify({ id: msg.id, ok: true, result: 'fine' }));
  });
  assert.equal(await bridge.call('navigate', {}), 'fine');
});
