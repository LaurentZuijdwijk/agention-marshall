import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createShellTool } from './shell-tool.js';
import type { ToolConfig } from '../types.js';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'marshall-shell-test-'));
}

function makeConfig(overrides: Partial<ToolConfig> = {}): ToolConfig {
  return {
    workspaceRoot: tempRoot(),
    approval: async () => 'approve',
    ...overrides,
  };
}

test('runs a safe command and reports the exit code', async () => {
  const tool = createShellTool(makeConfig());
  const result = await tool.execute('a', 'b', { command: 'echo hello' }, 'id');
  assert.match(result, /hello/);
  assert.match(result, /exit code: 0/);
});

test('reports a failing command with a non-zero exit code', async () => {
  const tool = createShellTool(makeConfig());
  const result = await tool.execute('a', 'b', { command: 'exit 3' }, 'id');
  assert.match(result, /exit code: 3/);
});

test('captures stderr', async () => {
  const tool = createShellTool(makeConfig());
  const result = await tool.execute('a', 'b', { command: 'echo oops >&2' }, 'id');
  assert.match(result, /oops/);
});

test('scopes the command to the workspace cwd', async () => {
  const workspaceRoot = tempRoot();
  const tool = createShellTool(makeConfig({ workspaceRoot }));
  const result = await tool.execute('a', 'b', { command: 'pwd' }, 'id');
  assert.match(result, new RegExp(workspaceRoot.replace(/[/\\]/g, '[$/\\\\]')));
});

test('describes the workspace-relative command convention', () => {
  const tool = createShellTool(makeConfig());
  const { description } = tool.getPrompt();
  assert.match(description, /already set/);
  assert.match(description, /Prefer relative paths/);
  assert.match(description, /absolute paths are allowed/);
  assert.match(description, /Do not invent machine-specific paths/);
});

test('blocks dangerous commands via the default denylist', async () => {
  const tool = createShellTool(makeConfig());
  const result = await tool.execute('a', 'b', { command: 'rm -rf /' }, 'id');
  assert.match(result, /Command blocked by policy/);
  assert.match(result, /rm -rf \//);
});

test('blocks system commands', async () => {
  const tool = createShellTool(makeConfig());
  const result = await tool.execute('a', 'b', { command: 'shutdown -h now' }, 'id');
  assert.match(result, /Command blocked by policy/);
});

test('runs allowed commands under an allowlist policy', async () => {
  const tool = createShellTool(makeConfig({
    commandPolicy: { mode: 'allowlist', patterns: [/^echo /] },
  }));
  const allowed = await tool.execute('a', 'b', { command: 'echo hi' }, 'id');
  assert.match(allowed, /hi/);
  const denied = await tool.execute('a', 'b', { command: 'ls' }, 'id');
  assert.match(denied, /Command blocked by policy/);
});

test('runs everything when policy mode is none', async () => {
  const tool = createShellTool(makeConfig({ commandPolicy: { mode: 'none' } }));
  const result = await tool.execute('a', 'b', { command: 'echo unrestricted' }, 'id');
  assert.match(result, /unrestricted/);
});

test('goes through the approval gate', async () => {
  const calls: string[] = [];
  const tool = createShellTool(makeConfig({
    approval: async (req) => { calls.push(req.description); return 'approve'; },
  }));
  await tool.execute('a', 'b', { command: 'echo ok' }, 'id');
  assert.ok(calls.some((d) => d.includes('echo ok')), 'approval should be consulted');
});

test('does not run a command when approval denies', async () => {
  const tool = createShellTool(makeConfig({ approval: async () => 'deny' }));
  const result = await tool.execute('a', 'b', { command: 'echo should-not-run' }, 'id');
  assert.match(result, /denied/i);
  assert.match(result, /Do not retry/i);
});

test('returns immediately when the signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  const tool = createShellTool(makeConfig({ signal: controller.signal }));
  const result = await tool.execute('a', 'b', { command: 'echo nope' }, 'id');
  assert.match(result, /Task interrupted/);
});
