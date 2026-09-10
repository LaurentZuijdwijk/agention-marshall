import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readAllCredentials, readCredentials, saveCredentials, clearCredentials,
  credentialsPath, isExpired,
} from './oauth-store.js';

/** Point HOME at a scratch directory for one test, so nothing here can read or
 *  overwrite the real login sitting in the developer's `~/.marshall`. */
function withHome(body: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'marshall-oauth-'));
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    body(home);
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
}

function write(home: string, contents: unknown): void {
  mkdirSync(join(home, '.marshall'), { recursive: true });
  writeFileSync(join(home, '.marshall', 'credentials.json'), JSON.stringify(contents));
}

const creds = (over: Partial<{ accessToken: string; refreshToken: string; expiresAt: number; accountId: string }> = {}) => ({
  accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000, ...over,
});

test('no file reads as logged out rather than throwing', () => {
  withHome(() => {
    assert.deepEqual(readAllCredentials(), {});
    assert.equal(readCredentials('codex'), null);
  });
});

test('a corrupt file behaves like no file', () => {
  withHome(home => {
    mkdirSync(join(home, '.marshall'), { recursive: true });
    writeFileSync(join(home, '.marshall', 'credentials.json'), '{not json');
    assert.deepEqual(readAllCredentials(), {});
  });
});

test('the pre-provider flat shape still reads as a Claude login', () => {
  withHome(home => {
    // What `marshall login` wrote before Codex existed. Someone upgrading must
    // not be silently signed out.
    write(home, { accessToken: 'old', refreshToken: 'old-r', expiresAt: 1 });
    assert.equal(readCredentials('claude')?.accessToken, 'old');
    assert.equal(readCredentials('codex'), null);
  });
});

test('signing in to one provider leaves the other alone', () => {
  withHome(() => {
    saveCredentials('claude', creds({ accessToken: 'claude-token' }));
    saveCredentials('codex', creds({ accessToken: 'codex-token', accountId: 'acct_1' }));
    assert.equal(readCredentials('claude')?.accessToken, 'claude-token');
    assert.equal(readCredentials('codex')?.accessToken, 'codex-token');
    assert.equal(readCredentials('codex')?.accountId, 'acct_1');
  });
});

test('a first Codex login upgrades the legacy file without dropping Claude', () => {
  withHome(home => {
    write(home, { accessToken: 'old', refreshToken: 'old-r', expiresAt: 1 });
    saveCredentials('codex', creds({ accessToken: 'new' }));
    assert.equal(readCredentials('claude')?.accessToken, 'old');
    assert.equal(readCredentials('codex')?.accessToken, 'new');
  });
});

test('the credential file is not world-readable', () => {
  withHome(home => {
    write(home, { claude: creds() });
    chmodSync(credentialsPath(), 0o644);
    saveCredentials('codex', creds());
    assert.equal(statSync(credentialsPath()).mode & 0o077, 0,
      'creating or replacing a permissive file must leave two bearer tokens owner-only');
  });
});

test('clearing one provider keeps the file and the other login', () => {
  withHome(() => {
    saveCredentials('claude', creds({ accessToken: 'claude-token' }));
    saveCredentials('codex', creds());
    clearCredentials('codex');
    assert.equal(readCredentials('codex'), null);
    assert.equal(readCredentials('claude')?.accessToken, 'claude-token');
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(credentialsPath(), 'utf8'))), ['claude']);
  });
});

test('clearing a provider that was never stored writes nothing', () => {
  withHome(() => {
    clearCredentials('codex');
    assert.deepEqual(readAllCredentials(), {});
  });
});

test('an entry with no access token reads as absent', () => {
  withHome(home => {
    write(home, { codex: { refreshToken: 'r', expiresAt: Date.now() + 1000 } });
    assert.equal(readCredentials('codex'), null);
  });
});

test('expiry leaves a minute of grace, so a token cannot die mid-request', () => {
  const now = 1_000_000;
  assert.equal(isExpired({ accessToken: 'a', refreshToken: 'r', expiresAt: now + 120_000 }, now), false);
  assert.equal(isExpired({ accessToken: 'a', refreshToken: 'r', expiresAt: now + 30_000 }, now), true,
    'inside the grace window counts as expired now rather than 30s from now');
  assert.equal(isExpired({ accessToken: 'a', refreshToken: 'r', expiresAt: now - 1 }, now), true);
});
