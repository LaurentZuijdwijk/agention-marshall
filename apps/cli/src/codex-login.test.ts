import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { startCodexLogin } from './codex-login.js';
import { readCredentials, CODEX_OAUTH } from '@agentionai/marshall-engine';

const CALLBACK = `http://127.0.0.1:${CODEX_OAUTH.callbackPort}${CODEX_OAUTH.callbackPath}`;

/**
 * A scratch HOME and a stubbed token endpoint for one test.
 *
 * The login writes to `~/.marshall/credentials.json` and posts to
 * auth.openai.com; neither is something a test run should actually do.
 */
async function withEnv(respond: () => Response, body: () => Promise<void>): Promise<void> {
  const previousHome = process.env.HOME;
  const previousFetch = globalThis.fetch;
  process.env.HOME = mkdtempSync(join(tmpdir(), 'marshall-login-'));
  // Only the token endpoint is stubbed. The callback requests the tests make
  // have to reach the real listener, so they go out through the saved `fetch`.
  const realFetch = previousFetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => (
    String(input).startsWith('http://127.0.0.1:') ? realFetch(input, init) : respond()
  )) as typeof globalThis.fetch;
  try {
    await body();
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    globalThis.fetch = previousFetch;
  }
}

function tokenResponse(): Response {
  const payload = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct_7' },
  })).toString('base64url');
  return new Response(JSON.stringify({
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    id_token: `h.${payload}.s`,
    expires_in: 3600,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/** The `state` the flow put in the URL it tried to open. */
function stateOf(authUrl: string): string {
  return new URL(authUrl).searchParams.get('state') ?? '';
}

test('the browser coming back with a code completes the sign-in', async () => {
  await withEnv(tokenResponse, async () => {
    let opened = '';
    const login = await startCodexLogin({ openBrowser: url => { opened = url; } });
    try {
      assert.equal(opened, login.authUrl, 'the URL opened is the one handed back to be printed');
      const auth = new URL(login.authUrl);
      assert.equal(auth.origin + auth.pathname, CODEX_OAUTH.authorizeUrl);
      assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(auth.searchParams.get('redirect_uri'), CODEX_OAUTH.redirectUri);
      assert.equal(auth.searchParams.get('scope'), CODEX_OAUTH.scopes);

      const res = await fetch(`${CALLBACK}?code=abc&state=${stateOf(login.authUrl)}`);
      assert.equal(res.status, 200);
      await login.completed;

      const saved = readCredentials('codex');
      assert.equal(saved?.accessToken, 'access-1');
      assert.equal(saved?.refreshToken, 'refresh-1');
      assert.equal(saved?.accountId, 'acct_7', 'read out of the id_token, for the Codex account header');
    } finally {
      login.cancel();
    }
  });
});

test('a callback carrying the wrong state is refused and does not end the flow', async () => {
  await withEnv(tokenResponse, async () => {
    const login = await startCodexLogin({ openBrowser: () => {} });
    try {
      // A stale redirect from another tab, or another process guessing. It must
      // neither complete the login nor cancel the one the user is waiting on.
      const bad = await fetch(`${CALLBACK}?code=abc&state=not-the-state`);
      assert.equal(bad.status, 400);
      assert.equal(readCredentials('codex'), null);

      const good = await fetch(`${CALLBACK}?code=abc&state=${stateOf(login.authUrl)}`);
      assert.equal(good.status, 200);
      await login.completed;
      assert.equal(readCredentials('codex')?.accessToken, 'access-1', 'the real callback still works after');
    } finally {
      login.cancel();
    }
  });
});

test('an error carrying the wrong state cannot cancel the active flow', async () => {
  await withEnv(tokenResponse, async () => {
    const login = await startCodexLogin({ openBrowser: () => {} });
    try {
      const bad = await fetch(`${CALLBACK}?error=access_denied&state=not-the-state`);
      assert.equal(bad.status, 400);

      const good = await fetch(`${CALLBACK}?code=abc&state=${stateOf(login.authUrl)}`);
      assert.equal(good.status, 200);
      await login.completed;
      assert.equal(readCredentials('codex')?.accessToken, 'access-1');
    } finally {
      login.cancel();
    }
  });
});

test('a callback with no state at all is refused', async () => {
  await withEnv(tokenResponse, async () => {
    const login = await startCodexLogin({ openBrowser: () => {} });
    try {
      assert.equal((await fetch(`${CALLBACK}?code=abc`)).status, 400);
      assert.equal(readCredentials('codex'), null);
    } finally {
      login.cancel();
    }
  });
});

test('a refusal at the consent screen is reported rather than left hanging', async () => {
  await withEnv(tokenResponse, async () => {
    const login = await startCodexLogin({ openBrowser: () => {} });
    const state = stateOf(login.authUrl);
    await fetch(`${CALLBACK}?error=access_denied&error_description=User+said+no&state=${state}`);
    await assert.rejects(login.completed, /User said no/);
    assert.equal(readCredentials('codex'), null);
  });
});

test('a failed token exchange surfaces the status and stores nothing', async () => {
  await withEnv(() => new Response('nope', { status: 401 }), async () => {
    const login = await startCodexLogin({ openBrowser: () => {} });
    await fetch(`${CALLBACK}?code=abc&state=${stateOf(login.authUrl)}`);
    await assert.rejects(login.completed, /401/);
    assert.equal(readCredentials('codex'), null);
  });
});

test('any other path on the listener is a 404, not a sign-in', async () => {
  await withEnv(tokenResponse, async () => {
    const login = await startCodexLogin({ openBrowser: () => {} });
    try {
      assert.equal((await fetch(`http://127.0.0.1:${CODEX_OAUTH.callbackPort}/`)).status, 404);
    } finally {
      login.cancel();
    }
  });
});

test('the port is released once the flow finishes', async () => {
  await withEnv(tokenResponse, async () => {
    const login = await startCodexLogin({ openBrowser: () => {} });
    await fetch(`${CALLBACK}?code=abc&state=${stateOf(login.authUrl)}`);
    await login.completed;
    // Sitting on 1455 after a successful login would block the next one — and
    // block the Codex CLI, which is registered on the same port.
    const second = await startCodexLogin({ openBrowser: () => {} });
    second.cancel();
    await assert.rejects(second.completed, /cancelled/);
  });
});

test('a port already in use names the likely cause', async () => {
  await withEnv(tokenResponse, async () => {
    const squatter = createServer(() => {});
    await new Promise<void>(resolve => squatter.listen(CODEX_OAUTH.callbackPort, '127.0.0.1', resolve));
    try {
      await assert.rejects(startCodexLogin({ openBrowser: () => {} }), /already in use/);
    } finally {
      squatter.close();
    }
  });
});

test('the flow gives up rather than holding the port forever', async () => {
  await withEnv(tokenResponse, async () => {
    const login = await startCodexLogin({ openBrowser: () => {}, timeoutMs: 20 });
    await assert.rejects(login.completed, /Timed out/);
  });
});

test('two sign-ins in a row get different PKCE state', async () => {
  await withEnv(tokenResponse, async () => {
    const first = await startCodexLogin({ openBrowser: () => {} });
    first.cancel();
    await assert.rejects(first.completed);
    const second = await startCodexLogin({ openBrowser: () => {} });
    second.cancel();
    await assert.rejects(second.completed);
    assert.notEqual(stateOf(first.authUrl), stateOf(second.authUrl));
    assert.notEqual(
      new URL(first.authUrl).searchParams.get('code_challenge'),
      new URL(second.authUrl).searchParams.get('code_challenge'),
    );
  });
});
