import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveInWorkspace, PathEscapeError } from './resolve.js';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'marshall-test-'));
}

test('resolves relative path within root', () => {
  const root = tempRoot();
  const result = resolveInWorkspace(root, 'src/index.ts');
  assert.equal(result, join(root, 'src/index.ts'));
});

test('resolves dot-relative path', () => {
  const root = tempRoot();
  const result = resolveInWorkspace(root, './foo');
  assert.equal(result, join(root, 'foo'));
});

test('resolves root itself', () => {
  const root = tempRoot();
  const result = resolveInWorkspace(root, '.');
  assert.equal(result, root);
});

test('allows absolute path inside root', () => {
  const root = tempRoot();
  const inside = join(root, 'deep/file.ts');
  const result = resolveInWorkspace(root, inside);
  assert.equal(result, inside);
});

test('rejects .. traversal that escapes root', () => {
  const root = tempRoot();
  assert.throws(() => resolveInWorkspace(root, '../../etc/passwd'), PathEscapeError);
});

test('rejects absolute path outside root', () => {
  const root = tempRoot();
  assert.throws(() => resolveInWorkspace(root, '/etc/passwd'), PathEscapeError);
});

test('rejects path that resolves to parent', () => {
  const root = tempRoot();
  assert.throws(() => resolveInWorkspace(root, 'foo/../../..'), PathEscapeError);
});

test('rejects symlink pointing outside root', () => {
  const root = tempRoot();
  const linkPath = join(root, 'escape');
  symlinkSync('/tmp', linkPath);
  assert.throws(() => resolveInWorkspace(root, 'escape/evil'), PathEscapeError);
});

test('allows symlink pointing inside root', () => {
  const root = tempRoot();
  const target = join(root, 'real');
  mkdirSync(target);
  const link = join(root, 'alias');
  symlinkSync(target, link);
  const result = resolveInWorkspace(root, 'alias');
  // realpath resolves the symlink
  assert.ok(result.startsWith(root));
});
