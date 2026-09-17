import assert from 'node:assert/strict';
import test from 'node:test';
import { startServer } from './http-server.js';

test('setup serves a credential-free install guide using the actual server port', async (t) => {
  const token = 'private-pairing-token-never-in-page';
  const server = await startServer({ port: 0, token });
  t.after(() => server.close());
  const health = await fetch(`http://127.0.0.1:${server.port}/health`);
  assert.deepEqual(await health.json(), { ok: true, plugin: 'marshall-browser-v1', extensionConnected: false });
  const response = await fetch(`http://127.0.0.1:${server.port}/setup`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  const html = await response.text();
  assert.match(html, /href="\/extension\.zip" download="marshall-browser-extension\.zip"/);
  for (const step of ['Extract the ZIP', 'chrome://extensions', 'edge://extensions', 'Developer mode',
    'Load unpacked', 'manifest.json', 'Save &amp; connect', 'Already installed?']) {
    assert.ok(html.includes(step), `missing setup step: ${step}`);
  }
  assert.ok(html.includes(`ws://127.0.0.1:${server.port}/bridge`));
  assert.ok(!html.includes(token));
  assert.doesNotMatch(html, /<script|\?token=/);
});
