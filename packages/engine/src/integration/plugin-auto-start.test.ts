// ── engine integration: a configured plugin starts itself ────────────────────
//
// Mirrors the MCP auto-connect behaviour session.ts already has, extended to
// plugins: a `plugins` entry with `enabled !== false` should come up without
// any command, and — the part that's easy to get wrong — its tools must be
// on the belt for the *first* turn, not just eventually. `Session.run()`
// already awaits `mcp.ready()` before building a turn's tools; if it didn't
// also await the plugin's own enable() (a separate, later `mcp.add()` call
// that `mcp.ready()` knows nothing about), a plugin still spawning would
// silently miss its first turn.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Session } from '../session.js';
import { startFakeProvider } from '../testing/fake-provider.js';
import { writeFixturePlugin } from '../testing/fixture-plugin.js';
import type { ClientInterface, EngineConfig } from '../index.js';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'marshall-plugin-autostart-'));
}

const silentClient: ClientInterface = {
  onOutput: () => {},
  requestApproval: async () => 'approve',
};

test('a configured, enabled plugin is running with its tools on the belt for the first turn', async (t) => {
  const fixture = await writeFixturePlugin({ name: 'auto' });
  t.after(fixture.cleanup);

  const root = tempRoot();
  const fake = await startFakeProvider({ text: 'ok' });
  t.after(() => fake.close());

  const session = new Session(
    {
      agent: { provider: 'llamacpp', host: fake.host, model: 'test-model' },
      workspaceRoot: root,
      compressionThreshold: 0,
      enableWebSearch: false,
      models: {
        deep: { provider: 'llamacpp', host: fake.host, model: 'test-model' },
        fast: { provider: 'llamacpp', host: fake.host, model: 'small-model' },
      },
      plugins: [{ package: fixture.descriptorUrl, name: 'auto' }],
    } satisfies EngineConfig,
    silentClient,
  );
  t.after(() => session.dispose());

  await session.run('anything');

  assert.equal(session.pluginState()[0].status, 'running', session.pluginState()[0].error);
  assert.ok(
    fake.requests[0].tools.includes('mcp__auto__ping'),
    `expected the plugin's tool on the first turn, got: ${JSON.stringify(fake.requests[0].tools)}`,
  );
});

test('a plugin configured with enabled: false stays off and never registers', async (t) => {
  const fixture = await writeFixturePlugin({ name: 'off' });
  t.after(fixture.cleanup);

  const root = tempRoot();
  const fake = await startFakeProvider({ text: 'ok' });
  t.after(() => fake.close());

  const session = new Session(
    {
      agent: { provider: 'llamacpp', host: fake.host, model: 'test-model' },
      workspaceRoot: root,
      compressionThreshold: 0,
      enableWebSearch: false,
      models: {
        deep: { provider: 'llamacpp', host: fake.host, model: 'test-model' },
        fast: { provider: 'llamacpp', host: fake.host, model: 'small-model' },
      },
      plugins: [{ package: fixture.descriptorUrl, name: 'off', enabled: false }],
    } satisfies EngineConfig,
    silentClient,
  );
  t.after(() => session.dispose());

  await session.run('anything');

  assert.equal(session.pluginState()[0].status, 'disabled');
  assert.equal(fake.requests[0].tools.includes('mcp__off__ping'), false);
});
