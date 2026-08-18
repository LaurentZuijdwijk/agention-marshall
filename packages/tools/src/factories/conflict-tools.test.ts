import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConflictTools } from './conflict-tools.js';
import type { ToolConfig } from '../types.js';

function git(cwd: string, args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync('git', args, { cwd, encoding: 'utf8' });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? '', status: e.status ?? 1 };
  }
}

/** A repo with one file conflicted between `main` and `feature`. */
function makeConflictedRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'marshall-conflict-test-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);

  writeFileSync(join(root, 'file.txt'), 'line 1\nshared\nline 3\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'base']);

  git(root, ['checkout', '-q', '-b', 'feature']);
  writeFileSync(join(root, 'file.txt'), 'line 1\nfeature change\nline 3\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'feature commit']);

  git(root, ['checkout', '-q', 'main']);
  writeFileSync(join(root, 'file.txt'), 'line 1\nmain change\nline 3\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'main commit']);

  git(root, ['merge', 'feature', '-q', '-m', 'merge']); // conflicts, leaves MERGE_HEAD
  return root;
}

/** A repo with two files, each independently conflicted between `main` and `feature`. */
function makeTwoFileConflictRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'marshall-conflict-test-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);

  writeFileSync(join(root, 'a.txt'), 'a1\nshared\na3\n');
  writeFileSync(join(root, 'b.txt'), 'b1\nshared\nb3\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'base']);

  git(root, ['checkout', '-q', '-b', 'feature']);
  writeFileSync(join(root, 'a.txt'), 'a1\nfeature a\na3\n');
  writeFileSync(join(root, 'b.txt'), 'b1\nfeature b\nb3\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'feature commit']);

  git(root, ['checkout', '-q', 'main']);
  writeFileSync(join(root, 'a.txt'), 'a1\nmain a\na3\n');
  writeFileSync(join(root, 'b.txt'), 'b1\nmain b\nb3\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'main commit']);

  git(root, ['merge', 'feature', '-q', '-m', 'merge']);
  return root;
}

function makeConfig(root: string, overrides: Partial<ToolConfig> = {}): ToolConfig {
  return {
    workspaceRoot: root,
    approval: async () => 'approve',
    ...overrides,
  };
}

function extractIds(listing: string): string[] {
  const matches = [...listing.matchAll(/\[([0-9a-f]{8})\]/g)].map((m) => m[1]);
  assert.ok(matches.length > 0, `expected at least one id in listing:\n${listing}`);
  return matches;
}

function extractId(listing: string): string {
  return extractIds(listing)[0];
}

test('returns list_conflicts and resolve_conflicts', () => {
  const root = mkdtempSync(join(tmpdir(), 'marshall-conflict-test-'));
  const names = createConflictTools(makeConfig(root)).map((t) => t.name).sort();
  assert.deepEqual(names, ['list_conflicts', 'resolve_conflicts']);
});

test('list_conflicts reports no conflicts outside a merge', async () => {
  const root = mkdtempSync(join(tmpdir(), 'marshall-conflict-test-'));
  git(root, ['init', '-q', '-b', 'main']);
  const tools = createConflictTools(makeConfig(root));
  const list = tools.find((t) => t.name === 'list_conflicts')!;
  const result = await list.execute('a', 'b', {}, 'id');
  assert.match(result, /no unresolved conflicts/i);
});

test('list_conflicts finds the hunk with an id, labels, commit ids, and context', async () => {
  const root = makeConflictedRepo();
  const tools = createConflictTools(makeConfig(root));
  const list = tools.find((t) => t.name === 'list_conflicts')!;
  const result = await list.execute('a', 'b', {}, 'id');

  assert.match(result, /file\.txt/);
  assert.match(result, /\[[0-9a-f]{8}\]/, 'should include a short hex id');
  assert.match(result, /ours \(HEAD @ [0-9a-f]+\)/);
  assert.match(result, /theirs \(feature @ [0-9a-f]+\)/);
  assert.match(result, /main change/);
  assert.match(result, /feature change/);
  assert.match(result, /line 1/, 'should include context before the hunk');
  assert.match(result, /line 3/, 'should include context after the hunk');
});

test('resolve_conflicts keeps ours', async () => {
  const root = makeConflictedRepo();
  const tools = createConflictTools(makeConfig(root));
  const list = tools.find((t) => t.name === 'list_conflicts')!;
  const resolve = tools.find((t) => t.name === 'resolve_conflicts')!;

  const id = extractId(await list.execute('a', 'b', {}, 'id'));
  const result = await resolve.execute('a', 'b', { resolutions: [{ id, choice: 'ours' }] }, 'id');
  assert.match(result, /resolved/i);

  const content = readFileSync(join(root, 'file.txt'), 'utf8');
  assert.equal(content, 'line 1\nmain change\nline 3\n');
});

test('resolve_conflicts keeps theirs', async () => {
  const root = makeConflictedRepo();
  const tools = createConflictTools(makeConfig(root));
  const list = tools.find((t) => t.name === 'list_conflicts')!;
  const resolve = tools.find((t) => t.name === 'resolve_conflicts')!;

  const id = extractId(await list.execute('a', 'b', {}, 'id'));
  await resolve.execute('a', 'b', { resolutions: [{ id, choice: 'theirs' }] }, 'id');

  const content = readFileSync(join(root, 'file.txt'), 'utf8');
  assert.equal(content, 'line 1\nfeature change\nline 3\n');
});

test('resolve_conflicts keeps both, ours first', async () => {
  const root = makeConflictedRepo();
  const tools = createConflictTools(makeConfig(root));
  const list = tools.find((t) => t.name === 'list_conflicts')!;
  const resolve = tools.find((t) => t.name === 'resolve_conflicts')!;

  const id = extractId(await list.execute('a', 'b', {}, 'id'));
  await resolve.execute('a', 'b', { resolutions: [{ id, choice: 'both' }] }, 'id');

  const content = readFileSync(join(root, 'file.txt'), 'utf8');
  assert.equal(content, 'line 1\nmain change\nfeature change\nline 3\n');
});

test('resolving the only hunk makes list_conflicts report the repo clean', async () => {
  const root = makeConflictedRepo();
  const tools = createConflictTools(makeConfig(root));
  const list = tools.find((t) => t.name === 'list_conflicts')!;
  const resolve = tools.find((t) => t.name === 'resolve_conflicts')!;

  const id = extractId(await list.execute('a', 'b', {}, 'id'));
  await resolve.execute('a', 'b', { resolutions: [{ id, choice: 'ours' }] }, 'id');

  const after = await list.execute('a', 'b', {}, 'id');
  assert.match(after, /no unresolved conflicts/i);
});

test('resolve_conflicts resolves multiple hunks across different files in one call', async () => {
  const root = makeTwoFileConflictRepo();
  const tools = createConflictTools(makeConfig(root));
  const list = tools.find((t) => t.name === 'list_conflicts')!;
  const resolve = tools.find((t) => t.name === 'resolve_conflicts')!;

  const listing = await list.execute('a', 'b', {}, 'id');
  const ids = extractIds(listing);
  assert.equal(ids.length, 2, 'expected one hunk per file');

  const result = await resolve.execute('a', 'b', {
    resolutions: [
      { id: ids[0], choice: 'ours' },
      { id: ids[1], choice: 'theirs' },
    ],
  }, 'id');

  assert.match(result, /resolved/i);
  assert.equal(result.split('\n').length, 2, 'one result line per resolution');

  const a = readFileSync(join(root, 'a.txt'), 'utf8');
  const b = readFileSync(join(root, 'b.txt'), 'utf8');
  assert.equal(a, 'a1\nmain a\na3\n');
  assert.equal(b, 'b1\nfeature b\nb3\n');

  const after = await list.execute('a', 'b', {}, 'id');
  assert.match(after, /no unresolved conflicts/i);
});

test('resolve_conflicts reports a per-item error without failing the rest of the batch', async () => {
  const root = makeTwoFileConflictRepo();
  const tools = createConflictTools(makeConfig(root));
  const list = tools.find((t) => t.name === 'list_conflicts')!;
  const resolve = tools.find((t) => t.name === 'resolve_conflicts')!;

  const ids = extractIds(await list.execute('a', 'b', {}, 'id'));
  const result = await resolve.execute('a', 'b', {
    resolutions: [
      { id: 'deadbeef', choice: 'ours' },
      { id: ids[0], choice: 'ours' },
    ],
  }, 'id');

  const lines = result.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /error/i);
  assert.match(lines[1], /resolved/i);
});

test('resolve_conflicts on an unknown id reports an error', async () => {
  const root = makeConflictedRepo();
  const tools = createConflictTools(makeConfig(root));
  const resolve = tools.find((t) => t.name === 'resolve_conflicts')!;
  const result = await resolve.execute('a', 'b', { resolutions: [{ id: 'deadbeef', choice: 'ours' }] }, 'id');
  assert.match(result, /error/i);
});

test('resolve_conflicts rejects an empty resolutions array', async () => {
  const root = makeConflictedRepo();
  const tools = createConflictTools(makeConfig(root));
  const resolve = tools.find((t) => t.name === 'resolve_conflicts')!;
  const result = await resolve.execute('a', 'b', { resolutions: [] }, 'id');
  assert.match(result, /error/i);
});

test('resolve_conflicts is gated behind approval', async () => {
  const root = makeConflictedRepo();
  let consulted = false;
  const tools = createConflictTools(makeConfig(root, {
    approval: async (req) => { consulted = true; assert.match(req.toolName, /resolve_conflicts/); return 'approve'; },
  }));
  const list = tools.find((t) => t.name === 'list_conflicts')!;
  const resolve = tools.find((t) => t.name === 'resolve_conflicts')!;
  const id = extractId(await list.execute('a', 'b', {}, 'id'));
  await resolve.execute('a', 'b', { resolutions: [{ id, choice: 'ours' }] }, 'id');
  assert.equal(consulted, true, 'resolve_conflicts must require approval');
});

test('resolve_conflicts is blocked when approval denies', async () => {
  const root = makeConflictedRepo();
  const tools = createConflictTools(makeConfig(root, { approval: async () => 'deny' }));
  const list = tools.find((t) => t.name === 'list_conflicts')!;
  const resolve = tools.find((t) => t.name === 'resolve_conflicts')!;
  const id = extractId(await list.execute('a', 'b', {}, 'id'));
  const result = await resolve.execute('a', 'b', { resolutions: [{ id, choice: 'ours' }] }, 'id');
  assert.match(result, /denied/i);

  const content = readFileSync(join(root, 'file.txt'), 'utf8');
  assert.match(content, /<<<<<<</, 'file must be untouched when approval denies');
});

test('list_conflicts is read-only and bypasses approval', async () => {
  const root = makeConflictedRepo();
  let consulted = false;
  const tools = createConflictTools(makeConfig(root, {
    approval: async () => { consulted = true; return 'approve'; },
  }));
  const list = tools.find((t) => t.name === 'list_conflicts')!;
  await list.execute('a', 'b', {}, 'id');
  assert.equal(consulted, false, 'list_conflicts should not require approval');
});
