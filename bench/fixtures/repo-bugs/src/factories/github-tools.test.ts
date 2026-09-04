import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGitHubTools } from './github-tools.js';
import type { ToolConfig } from '../types.js';

/**
 * Install a fake `gh` shim on PATH in a temp dir so we can exercise
 * createGitHubTools without hitting the real GitHub CLI or network.
 */
function makeShim(script: string): string {
  const bin = mkdtempSync(join(tmpdir(), 'marshall-gh-bin-'));
  const ghPath = join(bin, 'gh');
  writeFileSync(ghPath, script, { mode: 0o755 });
  chmodSync(ghPath, 0o755);
  return bin;
}

const SHIM = `#!/bin/sh
echo "args: $*"
`;

function makeConfig(root: string, overrides: Partial<ToolConfig> = {}): ToolConfig {
  return {
    workspaceRoot: root,
    approval: async () => 'approve',
    ...overrides,
  };
}

test('returns the four read-only tools plus two approval-gated tools', () => {
  const root = mkdtempSync(join(tmpdir(), 'marshall-gh-test-'));
  const tools = createGitHubTools(makeConfig(root));
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['gh_comment', 'gh_create_pr', 'gh_diff', 'gh_list_issues', 'gh_list_prs', 'gh_view_issue', 'gh_view_pr']);
});

test('gh_list_issues passes state and limit to gh', async () => {
  const bin = makeShim(SHIM);
  const root = mkdtempSync(join(tmpdir(), 'marshall-gh-test-'));
  const tools = createGitHubTools({ ...makeConfig(root), signal: undefined });
  const issue = tools.find((t) => t.name === 'gh_list_issues')!;
  const prevPath = process.env.PATH;
  process.env.PATH = `${bin}:${prevPath}`;
  try {
    const result = await issue.execute('a', 'b', { state: 'closed', limit: 5 }, 'id');
    assert.match(result, /issue list --state closed --limit 5/);
  } finally {
    process.env.PATH = prevPath;
  }
});

test('gh_view_issue appends --comments', async () => {
  const bin = makeShim(SHIM);
  const root = mkdtempSync(join(tmpdir(), 'marshall-gh-test-'));
  const tools = createGitHubTools(makeConfig(root));
  const view = tools.find((t) => t.name === 'gh_view_issue')!;
  const prevPath = process.env.PATH;
  process.env.PATH = `${bin}:${prevPath}`;
  try {
    const result = await view.execute('a', 'b', { number: 42 }, 'id');
    assert.match(result, /issue view 42 --comments/);
  } finally {
    process.env.PATH = prevPath;
  }
});

test('gh_create_pr is gated behind approval', async () => {
  let consulted = false;
  const root = mkdtempSync(join(tmpdir(), 'marshall-gh-test-'));
  const tools = createGitHubTools(makeConfig(root, {
    approval: async (req) => { consulted = true; assert.match(req.toolName, /gh_create_pr/); return 'approve'; },
  }));
  const createPr = tools.find((t) => t.name === 'gh_create_pr')!;
  await createPr.execute('a', 'b', { title: 'T', body: 'B' }, 'id');
  assert.equal(consulted, true, 'state-changing tool must require approval');
});

test('gh_create_pr is blocked when approval denies', async () => {
  const root = mkdtempSync(join(tmpdir(), 'marshall-gh-test-'));
  const tools = createGitHubTools(makeConfig(root, { approval: async () => 'deny' }));
  const createPr = tools.find((t) => t.name === 'gh_create_pr')!;
  const result = await createPr.execute('a', 'b', { title: 'T', body: 'B' }, 'id');
  assert.match(result, /denied/i);
});

test('gh_comment maps type to issue or pr noun', async () => {
  const bin = makeShim(SHIM);
  const root = mkdtempSync(join(tmpdir(), 'marshall-gh-test-'));
  const tools = createGitHubTools(makeConfig(root, { approval: async () => 'approve' }));
  const comment = tools.find((t) => t.name === 'gh_comment')!;
  const prevPath = process.env.PATH;
  process.env.PATH = `${bin}:${prevPath}`;
  try {
    const issue = await comment.execute('a', 'b', { number: 7, type: 'issue', body: 'hi' }, 'id');
    assert.match(issue, /issue comment 7 --body hi/);
    const pr = await comment.execute('a', 'b', { number: 8, type: 'pr', body: 'hey' }, 'id');
    assert.match(pr, /pr comment 8 --body hey/);
  } finally {
    process.env.PATH = prevPath;
  }
});

test('read-only tools do not require approval', async () => {
  let consulted = false;
  const root = mkdtempSync(join(tmpdir(), 'marshall-gh-test-'));
  const tools = createGitHubTools(makeConfig(root, { approval: async () => { consulted = true; return 'approve'; } }));
  const list = tools.find((t) => t.name === 'gh_list_prs')!;
  await list.execute('a', 'b', { state: 'open' }, 'id');
  assert.equal(consulted, false, 'read-only tools should bypass approval');
});

test('returns interrupted when the signal is aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  const root = mkdtempSync(join(tmpdir(), 'marshall-gh-test-'));
  const tools = createGitHubTools(makeConfig(root, { signal: controller.signal }));
  const list = tools.find((t) => t.name === 'gh_list_issues')!;
  const result = await list.execute('a', 'b', { state: 'open' }, 'id');
  assert.match(result, /interrupted/i);
});
