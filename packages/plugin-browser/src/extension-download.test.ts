import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { unzipSync, strFromU8 } from 'fflate';
import { startServer } from './http-server.js';

test('the published package includes a downloadable, loadable extension without credentials', async (t) => {
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  execFileSync(process.execPath, ['scripts/package-extension.mjs'], { cwd, stdio: 'pipe' });
  const server = await startServer({ port: 0, token: 'test-secret-must-not-ship' });
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.port}/extension.zip`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition') ?? '', /attachment;.*marshall-browser-extension.zip/);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual(Buffer.from(bytes), readFileSync(new URL('../dist/marshall-browser-extension.zip', import.meta.url)));
  const files = unzipSync(bytes);
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  assert.equal(manifest.manifest_version, 3);
  const required = [manifest.background.service_worker, manifest.action.default_popup,
    ...manifest.content_scripts.flatMap((script: { js: string[] }) => script.js), 'popup.js'];
  for (const name of required) assert.ok(files[name], `missing extension asset: ${name}`);
  for (const [name, content] of Object.entries(files)) {
    assert.ok(!name.endsWith('.map'));
    assert.ok(!strFromU8(content).includes('test-secret-must-not-ship'));
  }
  // Its own cache, not the developer's: this pack must not warm or evict real
  // entries. A fixed path under the temp dir would be worse than none at all on
  // a shared runner, where the first user to create it owns the permissions.
  const cache = mkdtempSync(join(tmpdir(), 'marshall-npm-cache-'));
  t.after(() => rmSync(cache, { recursive: true, force: true }));
  const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'],
    { cwd, encoding: 'utf8', env: { ...process.env, npm_config_cache: cache } }));
  assert.ok(packed[0].files.some((file: { path: string }) => file.path === 'dist/marshall-browser-extension.zip'));
});
