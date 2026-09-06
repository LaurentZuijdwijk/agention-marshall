// PluginRegistry against a real fake plugin — a standalone Node script
// genuinely spawned as a child process (not mocked), so `enable()`'s whole
// path (spawn → health poll → real MCP registration) is exercised for real.
// See testing/fixture-plugin.ts for how the fixture itself is built.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PluginRegistry } from './plugins.js';
import { McpRegistry } from './mcp.js';
import { writeFixturePlugin } from './testing/fixture-plugin.js';

const writeFixture = writeFixturePlugin;
function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

// Generous margins, not tight ones: this suite spawns real child processes
// alongside the rest of the engine's tests, and a slow CI box making one spawn
// take longer than a tight timeout produced exactly one flake during
// development. Still an order of magnitude faster than the real defaults.
const FAST = { startupTimeoutMs: 6000, startupPollIntervalMs: 50, healthTimeoutMs: 1000 };

test('enable spawns the plugin, waits for health, and registers it as an MCP server', async (t) => {
  const { descriptorUrl, dir } = await writeFixture();
  t.after(() => cleanup(dir));
  const mcp = new McpRegistry();
  const registry = new PluginRegistry(
    [{ package: descriptorUrl, name: 'fixture' }],
    { mcp, ...FAST },
  );
  t.after(() => registry.disposeAll());

  const { state, generatedToken } = await registry.enable('fixture');
  assert.equal(state.status, 'running', state.error);
  assert.ok(generatedToken, 'no token was configured, so one should have been minted');

  assert.deepEqual(mcp.state().map(s => s.status), ['connected']);
  assert.deepEqual(mcp.state()[0].toolNames, ['mcp__fixture__ping']);
});

test('the token reaches the spawned process via env, not argv', async (t) => {
  const { descriptorUrl, dir } = await writeFixture();
  t.after(() => cleanup(dir));
  const mcp = new McpRegistry();
  const registry = new PluginRegistry(
    [{ package: descriptorUrl, name: 'fixture', token: 'my-secret-token' }],
    { mcp, ...FAST },
  );
  t.after(() => registry.disposeAll());

  const { state, generatedToken } = await registry.enable('fixture');
  assert.equal(state.status, 'running', state.error);
  assert.equal(generatedToken, undefined, 'a token was already configured — none should be minted');
  assert.equal(readFileSync(join(dir, 'token.txt'), 'utf8'), 'my-secret-token');
});

test('a second enable while already healthy reuses the running process, no second spawn', async (t) => {
  const { descriptorUrl, dir } = await writeFixture();
  t.after(() => cleanup(dir));
  const mcp = new McpRegistry();
  const registry = new PluginRegistry(
    [{ package: descriptorUrl, name: 'fixture' }],
    { mcp, ...FAST },
  );
  t.after(() => registry.disposeAll());

  await registry.enable('fixture');
  const firstPid = readFileSync(join(dir, 'pid.txt'), 'utf8');

  await registry.enable('fixture');
  const secondPid = readFileSync(join(dir, 'pid.txt'), 'utf8');

  assert.equal(firstPid, secondPid, 'the same process should have answered both times');
});

test('disable kills the spawned process and unregisters the MCP server', async (t) => {
  const { descriptorUrl, dir } = await writeFixture();
  t.after(() => cleanup(dir));
  const mcp = new McpRegistry();
  const registry = new PluginRegistry(
    [{ package: descriptorUrl, name: 'fixture' }],
    { mcp, ...FAST },
  );
  t.after(() => registry.disposeAll());

  await registry.enable('fixture');
  const removed = await registry.disable('fixture');
  assert.equal(removed, true);
  assert.equal(mcp.isEmpty, true);
  assert.equal(registry.state()[0].status, 'disabled');
});

test('a plugin that never becomes healthy reports error and kills the job it started', async (t) => {
  const { descriptorUrl, dir } = await writeFixture({ failHealth: true });
  t.after(() => cleanup(dir));
  const mcp = new McpRegistry();
  const registry = new PluginRegistry(
    [{ package: descriptorUrl, name: 'fixture' }],
    { mcp, ...FAST },
  );
  t.after(() => registry.disposeAll());

  const { state } = await registry.enable('fixture');
  assert.equal(state.status, 'error');
  assert.match(state.error ?? '', /did not become healthy/);
  assert.equal(mcp.isEmpty, true, 'a never-healthy plugin must not end up registered');
});

test('a plugin package with no marshallPlugin export is an error, not a throw', async (t) => {
  const dir = mkdtempSync(join(process.cwd(), '.tmp-plugin-bad-'));
  t.after(() => cleanup(dir));
  writeFileSync(join(dir, 'bad.mjs'), 'export const somethingElse = 42;\n');
  const mcp = new McpRegistry();
  const registry = new PluginRegistry(
    [{ package: pathToFileURL(join(dir, 'bad.mjs')).href, name: 'bad' }],
    { mcp, ...FAST },
  );

  const { state } = await registry.enable('bad');
  assert.equal(state.status, 'error');
  assert.match(state.error ?? '', /does not export a valid marshallPlugin/);
});

test('add registers a not-yet-configured plugin and enables it in one step', async (t) => {
  const { descriptorUrl, dir } = await writeFixture();
  t.after(() => cleanup(dir));
  const mcp = new McpRegistry();
  const registry = new PluginRegistry([], { mcp, ...FAST });
  t.after(() => registry.disposeAll());

  const { state, generatedToken } = await registry.add({ package: descriptorUrl, name: 'fixture' });
  assert.equal(state.status, 'running', state.error);
  assert.ok(generatedToken);
  assert.deepEqual(mcp.state().map(s => s.status), ['connected']);
});

// Simulates a second Marshall session (or the CLI reaching a manually-started
// server): a fresh registry, no token of its own, pointed at a plugin whose
// server someone else already launched and holds the real token for. This
// registry must never fabricate a token it can't actually verify — see the
// comment in plugins.ts's enable().
test('enabling an already-running plugin with no token configured never fabricates one', async (t) => {
  const { descriptorUrl, dir } = await writeFixture();
  t.after(() => cleanup(dir));
  const mcp = new McpRegistry();

  const firstSession = new PluginRegistry([{ package: descriptorUrl, name: 'fixture' }], { mcp, ...FAST });
  const first = await firstSession.enable('fixture');
  t.after(() => firstSession.disposeAll());
  assert.equal(first.state.status, 'running', first.state.error);
  assert.ok(first.generatedToken, 'the launcher should mint the real token');

  // A second registry with no memory of that token, pointed at the same
  // (already healthy) server.
  const secondMcp = new McpRegistry();
  const secondSession = new PluginRegistry([{ package: descriptorUrl, name: 'fixture' }], { mcp: secondMcp, ...FAST });
  const second = await secondSession.enable('fixture');

  assert.equal(second.state.status, 'running', second.state.error);
  assert.equal(second.generatedToken, undefined, 'no token was actually minted or sent anywhere for this call');
  assert.equal(secondSession.configs()[0].token, undefined, 'nothing to persist either — a wrong token is worse than none');
});

test('add with enabled: false registers without starting anything', async (t) => {
  const { descriptorUrl, dir } = await writeFixture();
  t.after(() => cleanup(dir));
  const mcp = new McpRegistry();
  const registry = new PluginRegistry([], { mcp, ...FAST });

  const { state } = await registry.add({ package: descriptorUrl, name: 'fixture', enabled: false });
  assert.equal(state.status, 'disabled');
  assert.equal(mcp.isEmpty, true);
});

test('enabling an unconfigured name reports an error instead of throwing', async () => {
  const registry = new PluginRegistry([], { mcp: new McpRegistry(), ...FAST });
  const { state } = await registry.enable('nope');
  assert.equal(state.status, 'error');
  assert.match(state.error ?? '', /no plugin named/);
});

test('a disabled-by-default plugin is skipped by enableAll', async (t) => {
  const { descriptorUrl, dir } = await writeFixture();
  t.after(() => cleanup(dir));
  const mcp = new McpRegistry();
  const registry = new PluginRegistry(
    [{ package: descriptorUrl, name: 'fixture', enabled: false }],
    { mcp, ...FAST },
  );
  t.after(() => registry.disposeAll());

  await registry.enableAll();
  assert.equal(registry.state()[0].status, 'disabled');
  assert.equal(mcp.isEmpty, true);
});

test('a crashed process is cleaned out of the MCP registry via onExit', async (t) => {
  const { descriptorUrl, dir } = await writeFixture();
  t.after(() => cleanup(dir));
  const mcp = new McpRegistry();
  const registry = new PluginRegistry(
    [{ package: descriptorUrl, name: 'fixture' }],
    { mcp, ...FAST },
  );
  t.after(() => registry.disposeAll());

  const { state: enabled } = await registry.enable('fixture');
  assert.equal(enabled.status, 'running', enabled.error);

  const pid = Number(readFileSync(join(dir, 'pid.txt'), 'utf8'));
  process.kill(pid, 'SIGKILL');

  // onJobExit runs off the child's 'close' event — give it a moment.
  await new Promise(resolve => setTimeout(resolve, 500));

  assert.equal(registry.state()[0].status, 'error');
  assert.match(registry.state()[0].error ?? '', /exited unexpectedly/);
  assert.equal(mcp.isEmpty, true);
});

test('configs() reflects a freshly generated token and current enabled state', async (t) => {
  const { descriptorUrl, dir } = await writeFixture();
  t.after(() => cleanup(dir));
  const mcp = new McpRegistry();
  const registry = new PluginRegistry(
    [{ package: descriptorUrl, name: 'fixture' }],
    { mcp, ...FAST },
  );
  t.after(() => registry.disposeAll());

  const { state: enabled } = await registry.enable('fixture');
  assert.equal(enabled.status, 'running', enabled.error);
  const [config] = registry.configs();
  assert.equal(config.name, 'fixture');
  assert.ok(config.token, 'the minted token should be readable back for persistence');
  assert.equal(config.enabled, true);

  await registry.disable('fixture');
  assert.equal(registry.configs()[0].enabled, false);
  assert.equal(registry.configs()[0].token, config.token, 'disable must not clear the token');
});
