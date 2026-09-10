import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { History } from '@agentionai/agents/core';
import { CODEX_BASE_URL, CODEX_ORIGINATOR } from '@agentionai/agents/openai';
import { createAgent } from './agent-factory.js';
import { saveCredentials } from './oauth-store.js';
import { resolveAuth } from './config.js';
import type { AgentProfile } from './config.js';

/**
 * What a `codex` profile actually puts on the wire.
 *
 * The SDK owns the transport now, so this is not testing its internals — it is
 * testing that Marshall hands it the right things: the stored token, the
 * account to bill, a Codex model id rather than a platform one, and none of the
 * parameters this backend rejects.
 */

interface Seen { url: string; headers: Record<string, string>; body: Record<string, unknown> }

/** Fire one turn and report the request that went out, whatever the agent then
 *  makes of the response — the request is the part under test. */
async function requestFor(
  profile: Partial<AgentProfile> = {},
  stored: Parameters<typeof saveCredentials>[1] = {
    accessToken: 'live-token', refreshToken: 'r1', expiresAt: Date.now() + 3_600_000, accountId: 'acct_5',
  },
  options: Parameters<typeof createAgent>[3] = {},
): Promise<Seen> {
  const previousHome = process.env.HOME;
  const previousFetch = globalThis.fetch;
  process.env.HOME = mkdtempSync(join(tmpdir(), 'marshall-codex-'));
  const seen: Seen[] = [];
  globalThis.fetch = (async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
    const raw = init?.body === undefined ? '{}' : String(init.body);
    seen.push({ url: String(input), headers, body: raw.startsWith('{') ? JSON.parse(raw) : {} });
    // Deliberately not a valid Responses stream. The turn fails, which is fine:
    // building a faithful SSE transcript would be testing the SDK's parser, not
    // this wiring.
    return new Response('', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof globalThis.fetch;

  try {
    saveCredentials('codex', stored);
    const agent = await createAgent({ provider: 'codex', ...profile }, [], new History([], { transient: true }), options);
    await agent.execute('hi').catch(() => {});
    assert.ok(seen.length > 0, 'a request was made');
    return seen[0];
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    globalThis.fetch = previousFetch;
  }
}

test('a codex profile goes to the ChatGPT backend, not the platform API', async () => {
  const call = await requestFor();
  assert.ok(call.url.startsWith(CODEX_BASE_URL), `expected the Codex backend, got ${call.url}`);
  assert.ok(!call.url.includes('api.openai.com'), 'a ChatGPT token is not a platform key');
  assert.ok(call.url.endsWith('/responses'), 'the Codex backend speaks the Responses API');
});

test('the turn carries the stored token and the account to bill', async () => {
  const call = await requestFor();
  assert.equal(call.headers.authorization, 'Bearer live-token');
  assert.equal(call.headers['chatgpt-account-id'], 'acct_5');
});

test('the originator is the one OpenAI gates the model catalogue on', async () => {
  // An unrecognised value quietly changes which models the account may reach,
  // so this is worth pinning rather than leaving to a default we never see.
  assert.equal((await requestFor()).headers.originator, CODEX_ORIGINATOR);
});

test('the request satisfies the backend validations that are otherwise a bare 400', async () => {
  const call = await requestFor();
  assert.ok(call.body.instructions, '"Instructions are required"');
  assert.equal(call.body.stream, true, '"Stream must be set to true"');
  assert.equal(call.body.store, false, '"Store must be set to false"');
  assert.ok(Array.isArray(call.body.input), '"Input must be a list"');
  assert.equal('max_output_tokens' in call.body, false, '"Unsupported parameter: max_output_tokens"');
});

test('the default model is one this backend actually serves', async () => {
  // The platform ids (`gpt-5.6`, `gpt-4.1-mini`) are rejected outright here, so
  // the provider default cannot be shared with `openai`.
  assert.equal((await requestFor()).body.model, 'gpt-5.6-luna');
});

test('an explicit codex model is passed through', async () => {
  assert.equal((await requestFor({ model: 'gpt-6-astra' })).body.model, 'gpt-6-astra');
});

test('reasoning effort below what Codex offers is raised to its floor', async () => {
  // Marshall's scale has `none`/`minimal`; the Codex models start at `low`.
  // Folding down beats being silently given the `medium` default.
  const call = await requestFor({ reasoningEffort: 'minimal' });
  assert.equal((call.body.reasoning as { effort?: string } | undefined)?.effort, 'low');
  const high = await requestFor({ reasoningEffort: 'xhigh' });
  assert.equal((high.body.reasoning as { effort?: string } | undefined)?.effort, 'xhigh');
});

test('a login with no account claim sends no account header at all', async () => {
  const call = await requestFor({}, { accessToken: 'live-token', refreshToken: 'r1', expiresAt: Date.now() + 3_600_000 });
  assert.equal('chatgpt-account-id' in call.headers, false,
    'an empty account assertion is worse than letting the backend pick the default');
});

test('no login refuses before a request is ever built', async () => {
  const previousHome = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), 'marshall-codex-none-'));
  try {
    assert.throws(() => resolveAuth({ provider: 'codex' }), /\/login codex/);
    await assert.rejects(
      createAgent({ provider: 'codex' }, [], new History([], { transient: true })),
      /login codex/,
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  }
});

test('a platform key does not stand in for a ChatGPT login', async () => {
  // There is no `sk-...` that works against this backend, so a key left on the
  // profile has to be refused rather than sent and 401'd.
  const previousHome = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), 'marshall-codex-key-'));
  try {
    assert.throws(() => resolveAuth({ provider: 'codex', apiKey: 'sk-platform' }), /\/login codex/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  }
});

test('a session id becomes the header the backend groups its prompt cache by', async () => {
  // Not `prompt_cache_key`: that is the platform API's lever and does nothing
  // on this backend. Without the header a tool loop replays its whole prefix
  // uncached every hop — measured at 2% of input reused against the Codex
  // CLI's 78-97% on the same account and model.
  const call = await requestFor({}, undefined, { sessionId: 'sess-abc' });
  assert.equal(call.headers['session_id'], 'sess-abc');
});

test('no session id sends no header, leaving the request as it was', async () => {
  // The opt-in is the SDK's, and it matters: an unasked-for header changes the
  // request for every caller that never wanted caching grouped this way.
  const call = await requestFor();
  assert.equal('session_id' in call.headers, false);
});

test('the turn asks for reasoning it can replay on the next hop', async () => {
  // `store: false` is forced here, so the reasoning chain only survives if the
  // encrypted blob comes back and is sent again — which is what keeps the
  // cached prefix matching across a tool loop.
  const call = await requestFor();
  assert.deepEqual(call.body.include, ['reasoning.encrypted_content']);
});
