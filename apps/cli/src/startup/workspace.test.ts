import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findGitRoot, resolveWorkspaceRoot, loadEnvFiles } from './workspace.js';

let root: string;

beforeEach(() => {
  // realpath because macOS hands out /var/… symlinks for /private/var/…, which
  // would make every path assertion below fail on that platform alone.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'marshall-ws-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const repo = (...segments: string[]) => {
  const dir = join(root, ...segments);
  mkdirSync(dir, { recursive: true });
  return dir;
};

describe('findGitRoot', () => {
  it('finds the repo from a nested directory', () => {
    mkdirSync(join(root, '.git'));
    const deep = repo('packages', 'engine', 'src');
    assert.equal(findGitRoot(deep), root);
  });

  it('returns the directory itself when it is the repo root', () => {
    mkdirSync(join(root, '.git'));
    assert.equal(findGitRoot(root), root);
  });

  it('stops at the innermost repo, not the outermost', () => {
    mkdirSync(join(root, '.git'));
    const nested = repo('vendor', 'thing');
    mkdirSync(join(nested, '.git'));
    assert.equal(findGitRoot(join(nested, 'src')), nested);
  });

  it('returns null when nothing above is a repo', () => {
    // No .git anywhere in the temp tree; the walk ends at the filesystem root
    // rather than looping forever.
    assert.equal(findGitRoot(repo('a', 'b')), null);
  });
});

describe('resolveWorkspaceRoot', () => {
  it('prefers an explicit path over the enclosing repo', () => {
    mkdirSync(join(root, '.git'));
    const elsewhere = repo('elsewhere');
    assert.equal(resolveWorkspaceRoot(elsewhere, root), elsewhere);
  });

  it('resolves a relative path against the working directory', () => {
    const sub = repo('sub');
    assert.equal(resolveWorkspaceRoot('sub', root), sub);
  });

  it('falls back to the enclosing repo when no path is given', () => {
    mkdirSync(join(root, '.git'));
    assert.equal(resolveWorkspaceRoot(undefined, repo('a', 'b')), root);
  });

  it('falls back to the working directory outside a repo', () => {
    const here = repo('a', 'b');
    assert.equal(resolveWorkspaceRoot(undefined, here), here);
  });
});

describe('loadEnvFiles', () => {
  const KEY = 'MARSHALL_TEST_ENV_VALUE';

  afterEach(() => { delete process.env[KEY]; });

  it('loads the workspace .env', () => {
    writeFileSync(join(root, '.env'), `${KEY}=from-workspace\n`);
    mkdirSync(join(root, '.git'));
    loadEnvFiles(root, root);
    assert.equal(process.env[KEY], 'from-workspace');
  });

  it('walks up from the working directory to the repo root', () => {
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.env'), `${KEY}=from-repo-root\n`);
    const deep = repo('apps', 'cli');
    loadEnvFiles(deep, deep);
    assert.equal(process.env[KEY], 'from-repo-root');
  });

  it('lets the nearest .env win over one further up', () => {
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.env'), `${KEY}=from-repo-root\n`);
    const app = repo('apps', 'cli');
    writeFileSync(join(app, '.env'), `${KEY}=from-app\n`);
    loadEnvFiles(app, app);
    assert.equal(process.env[KEY], 'from-app');
  });

  it('never overrides a variable already in the environment', () => {
    process.env[KEY] = 'from-shell';
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.env'), `${KEY}=from-file\n`);
    loadEnvFiles(root, root);
    assert.equal(process.env[KEY], 'from-shell');
  });

  it('is a no-op when there is no .env to find', () => {
    mkdirSync(join(root, '.git'));
    loadEnvFiles(root, root);
    assert.equal(process.env[KEY], undefined);
  });
});
