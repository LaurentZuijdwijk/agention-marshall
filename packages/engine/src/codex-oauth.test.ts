import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CODEX_OAUTH, claimsFrom, expiryOf, toCredentials, exchangeCodexCode,
  toCodexCredentials, fromCodexCredentials, importCodexCliLogin, codexCredentials,
} from './codex-oauth.js';
import { readCredentials } from './oauth-store.js';

/** A signature-less JWT — nothing here verifies one, by design. */
function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

const NAMESPACE = 'https://api.openai.com/auth';

async function withEnv(
  respond: (body: Record<string, string>) => Response,
  body: (calls: Array<Record<string, string>>) => Promise<void>,
): Promise<void> {
  const previousHome = process.env.HOME;
  const previousFetch = globalThis.fetch;
  process.env.HOME = mkdtempSync(join(tmpdir(), 'marshall-codex-'));
  const calls: Array<Record<string, string>> = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const parsed = Object.fromEntries(new URLSearchParams(String(init.body)));
    calls.push(parsed);
    return respond(parsed);
  }) as typeof globalThis.fetch;
  try {
    await body(calls);
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    globalThis.fetch = previousFetch;
  }
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// ── claims ──────────────────────────────────────────────────────────────────

test('the account id, email and plan come out of the namespaced claim', () => {
  assert.deepEqual(
    claimsFrom(jwt({ [NAMESPACE]: { chatgpt_account_id: 'acct_9', chatgpt_plan_type: 'pro' }, email: 'a@b.c' })),
    { accountId: 'acct_9', email: 'a@b.c', planType: 'pro' },
  );
});

test('a flat account id claim is read too', () => {
  assert.deepEqual(claimsFrom(jwt({ chatgpt_account_id: 'acct_flat' })), { accountId: 'acct_flat' });
});

test('a missing, malformed or claimless id_token yields nothing rather than throwing', () => {
  assert.deepEqual(claimsFrom(undefined), {});
  assert.deepEqual(claimsFrom('not-a-jwt'), {});
  assert.deepEqual(claimsFrom(jwt({ sub: 'user_1' })), {});
});

// ── expiry ──────────────────────────────────────────────────────────────────

test("the token's own exp claim wins over expires_in", () => {
  // `exp` is what the backend enforces, and unlike `expires_in` it does not
  // drift with however long the response spent in transit.
  const exp = Math.floor(Date.now() / 1000) + 7200;
  assert.equal(expiryOf({ access_token: jwt({ exp }), expires_in: 60 }), exp * 1000);
});

test('expires_in is the fallback for an opaque access token', () => {
  const now = 1_000_000;
  assert.equal(expiryOf({ access_token: 'opaque', expires_in: 120 }, now), now + 120_000);
});

test('neither expiry falls back to an hour rather than never refreshing', () => {
  const now = 1_000_000;
  assert.equal(expiryOf({ access_token: 'opaque' }, now), now + 3_600_000);
});

// ── credential mapping ──────────────────────────────────────────────────────

test('a refresh that omits the refresh token or claims keeps the previous ones', () => {
  // Dropping either signs the user out at the *next* expiry, an hour after the
  // change that caused it.
  const previous = { accessToken: 'old', refreshToken: 'keep-me', expiresAt: 0, accountId: 'acct_1', planType: 'plus' };
  const next = toCredentials({ access_token: 'new', expires_in: 3600 }, previous);
  assert.equal(next.refreshToken, 'keep-me');
  assert.equal(next.accountId, 'acct_1');
  assert.equal(next.planType, 'plus');
});

test('a rotated refresh token and fresh claims replace the old ones', () => {
  const next = toCredentials(
    { access_token: 'new', refresh_token: 'rotated', id_token: jwt({ [NAMESPACE]: { chatgpt_account_id: 'acct_2' } }), expires_in: 60 },
    { accessToken: 'old', refreshToken: 'stale', expiresAt: 0, accountId: 'acct_1' },
  );
  assert.equal(next.refreshToken, 'rotated');
  assert.equal(next.accountId, 'acct_2');
});

test('our shape round-trips through the SDK shape', () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const ours = { accessToken: jwt({ exp }), refreshToken: 'r', expiresAt: exp * 1000, accountId: 'acct_1', planType: 'pro' };
  assert.deepEqual(fromCodexCredentials(toCodexCredentials(ours)), ours);
});

test('a credential file with no expiry is treated as due for refresh', () => {
  // An `auth.json` written by the Codex CLI carries no `expires_in`, and an
  // opaque token carries no `exp`. Assuming it is live would mean a 401 on the
  // first request instead of a refresh.
  const now = 1_000_000;
  assert.equal(fromCodexCredentials({ accessToken: 'opaque', refreshToken: 'r' }, now).expiresAt, now);
});

test('the SDK shape omits absent fields rather than sending them empty', () => {
  assert.deepEqual(toCodexCredentials({ accessToken: 'a', refreshToken: '', expiresAt: 0 }), { accessToken: 'a' });
});

// ── the code exchange ───────────────────────────────────────────────────────

test('the code exchange is form-encoded, names this client and sends the verifier', async () => {
  await withEnv(() => json({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }), async calls => {
    await exchangeCodexCode('the-code', 'the-verifier');
    assert.deepEqual(calls[0], {
      grant_type: 'authorization_code',
      client_id: CODEX_OAUTH.clientId,
      code: 'the-code',
      redirect_uri: CODEX_OAUTH.redirectUri,
      code_verifier: 'the-verifier',
    });
  });
});

test('a refused exchange reports the status and body', async () => {
  await withEnv(() => new Response('invalid_grant', { status: 400 }), async () => {
    await assert.rejects(exchangeCodexCode('bad', 'v'), /400.*invalid_grant/s);
  });
});

test('the client id is the Codex CLI public client, taken from the SDK', async () => {
  // Shared rather than duplicated: two copies of this constant is two things to
  // update when OpenAI rotates it.
  const { CODEX_CLIENT_ID } = await import('@agentionai/agents/openai');
  assert.equal(CODEX_OAUTH.clientId, CODEX_CLIENT_ID);
});

// ── adopting an existing `codex login` ──────────────────────────────────────

test('an existing codex CLI login is imported and stored', async () => {
  await withEnv(() => json({}), async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-home-'));
    const exp = Math.floor(Date.now() / 1000) + 3600;
    writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({
      tokens: { access_token: jwt({ exp, [NAMESPACE]: { chatgpt_account_id: 'acct_cli' } }), refresh_token: 'cli-r', account_id: 'acct_cli' },
    }));
    const imported = await importCodexCliLogin(codexHome);
    assert.ok(imported, 'the CLI login was adopted');
    assert.equal(imported.refreshToken, 'cli-r');
    assert.equal(readCredentials('codex')?.refreshToken, 'cli-r', 'and persisted, so it survives a restart');
  });
});

test('no codex CLI login is an ordinary absence, not a failure', async () => {
  await withEnv(() => json({}), async () => {
    assert.equal(await importCodexCliLogin(mkdtempSync(join(tmpdir(), 'codex-empty-'))), null);
    assert.equal(codexCredentials(), null);
  });
});

test('an unreadable codex auth file imports as nothing', async () => {
  await withEnv(() => json({}), async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-bad-'));
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, 'auth.json'), '{not json');
    assert.equal(await importCodexCliLogin(codexHome), null);
  });
});
