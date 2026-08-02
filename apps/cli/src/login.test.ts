import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildAuthSession, completeLogin, refreshCredentials } from './login.js';
import type { MarshallCredentials } from './login.js';

const base64url = (buf: Buffer) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

describe('buildAuthSession', () => {
  it('sends an S256 challenge derived from the verifier', () => {
    const { verifier, authUrl } = buildAuthSession();
    const params = new URL(authUrl).searchParams;
    assert.equal(params.get('code_challenge_method'), 'S256');
    assert.equal(
      params.get('code_challenge'),
      base64url(createHash('sha256').update(verifier).digest()),
      'the server can only match the verifier if the challenge is its SHA-256',
    );
  });

  it('uses base64url — no +, / or = to be mangled in a URL', () => {
    for (let i = 0; i < 20; i++) {
      const { verifier } = buildAuthSession();
      assert.doesNotMatch(verifier, /[+/=]/);
    }
  });

  it('never repeats a verifier', () => {
    const seen = new Set(Array.from({ length: 50 }, () => buildAuthSession().verifier));
    assert.equal(seen.size, 50);
  });

  it('carries the state the callback will echo back', () => {
    const { state, authUrl } = buildAuthSession();
    assert.equal(new URL(authUrl).searchParams.get('state'), state);
  });

  it('asks for the scopes the CLI needs', () => {
    const scope = new URL(buildAuthSession().authUrl).searchParams.get('scope');
    assert.ok(scope?.includes('user:inference'), 'inference is what the agents run on');
  });
});

describe('completeLogin', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  const session = { verifier: 'v', state: 'v', authUrl: 'https://example' };

  it('rejects an empty paste without calling the token endpoint', async () => {
    let called = false;
    globalThis.fetch = (async () => { called = true; }) as typeof globalThis.fetch;
    await assert.rejects(() => completeLogin('   ', session), /No code provided/);
    assert.equal(called, false);
  });

  it('strips the #state fragment the callback page appends', async () => {
    let sent: Record<string, string> | null = null;
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return { ok: false, status: 400, text: async () => 'stop here' };
    }) as unknown as typeof globalThis.fetch;

    await assert.rejects(() => completeLogin('THE-CODE#THE-STATE', session));
    assert.equal(sent!.code, 'THE-CODE');
    assert.equal(sent!.code_verifier, 'v');
  });

  it('surfaces the status and body when the exchange fails', async () => {
    globalThis.fetch = (async () => ({
      ok: false, status: 403, text: async () => 'invalid_grant',
    })) as unknown as typeof globalThis.fetch;

    await assert.rejects(() => completeLogin('code', session), /403.*invalid_grant/);
  });
});

describe('refreshCredentials', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  const existing: MarshallCredentials = {
    accessToken: 'old-access', refreshToken: 'the-refresh-token', expiresAt: 0,
  };

  it('keeps the old refresh token when the server does not send a new one', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ access_token: 'new-access', expires_in: 3600 }),
    })) as unknown as typeof globalThis.fetch;

    const next = await refreshCredentials(existing);
    assert.equal(next.accessToken, 'new-access');
    assert.equal(next.refreshToken, 'the-refresh-token',
      'dropping it would make the next refresh impossible');
  });

  it('adopts a rotated refresh token', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ access_token: 'a', refresh_token: 'rotated', expires_in: 60 }),
    })) as unknown as typeof globalThis.fetch;

    assert.equal((await refreshCredentials(existing)).refreshToken, 'rotated');
  });

  it('turns expires_in seconds into an absolute expiry', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ access_token: 'a', expires_in: 3600 }),
    })) as unknown as typeof globalThis.fetch;

    const before = Date.now();
    const { expiresAt } = await refreshCredentials(existing);
    assert.ok(expiresAt >= before + 3600_000 && expiresAt <= Date.now() + 3600_000);
  });
});
