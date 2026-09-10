import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveModel,
  resolveApiKey,
  resolveAuth,
  cheapModelFor,
  PROVIDER_DEFAULTS,
  CHEAP_MODELS,
} from './config.js';
import type { AgentProfile } from './config.js';

// ---------------------------------------------------------------------------
// resolveModel
// ---------------------------------------------------------------------------

test('resolveModel returns profile.model when set', () => {
  const profile: AgentProfile = { provider: 'claude', model: 'custom-model' };
  assert.equal(resolveModel(profile), 'custom-model');
});

test('resolveModel falls back to PROVIDER_DEFAULTS for claude', () => {
  const profile: AgentProfile = { provider: 'claude' };
  assert.equal(resolveModel(profile), PROVIDER_DEFAULTS.claude.model);
});

test('resolveModel falls back to PROVIDER_DEFAULTS for openai', () => {
  const profile: AgentProfile = { provider: 'openai' };
  assert.equal(resolveModel(profile), PROVIDER_DEFAULTS.openai.model);
});

test('resolveModel falls back to PROVIDER_DEFAULTS for gemini', () => {
  const profile: AgentProfile = { provider: 'gemini' };
  assert.equal(resolveModel(profile), PROVIDER_DEFAULTS.gemini.model);
});

test('resolveModel falls back to PROVIDER_DEFAULTS for mistral', () => {
  const profile: AgentProfile = { provider: 'mistral' };
  assert.equal(resolveModel(profile), PROVIDER_DEFAULTS.mistral.model);
});

test('resolveModel falls back to PROVIDER_DEFAULTS for ollama', () => {
  const profile: AgentProfile = { provider: 'ollama' };
  assert.equal(resolveModel(profile), PROVIDER_DEFAULTS.ollama.model);
});

// ---------------------------------------------------------------------------
// resolveApiKey
// ---------------------------------------------------------------------------

test('resolveApiKey returns profile.apiKey when explicitly provided', () => {
  const profile: AgentProfile = { provider: 'claude', apiKey: 'sk-explicit' };
  assert.equal(resolveApiKey(profile), 'sk-explicit');
});

test('resolveApiKey reads ANTHROPIC_API_KEY env var for claude', () => {
  const profile: AgentProfile = { provider: 'claude' };
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'env-key-claude';
  try {
    assert.equal(resolveApiKey(profile), 'env-key-claude');
  } finally {
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prev;
  }
});

test('resolveApiKey reads OPENAI_API_KEY env var for openai', () => {
  const profile: AgentProfile = { provider: 'openai' };
  const prev = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'env-key-openai';
  try {
    assert.equal(resolveApiKey(profile), 'env-key-openai');
  } finally {
    if (prev === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prev;
  }
});

test('resolveApiKey reads GEMINI_API_KEY env var for gemini', () => {
  const profile: AgentProfile = { provider: 'gemini' };
  const prev = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'env-key-gemini';
  try {
    assert.equal(resolveApiKey(profile), 'env-key-gemini');
  } finally {
    if (prev === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prev;
  }
});

test('resolveApiKey reads MISTRAL_API_KEY env var for mistral', () => {
  const profile: AgentProfile = { provider: 'mistral' };
  const prev = process.env.MISTRAL_API_KEY;
  process.env.MISTRAL_API_KEY = 'env-key-mistral';
  try {
    assert.equal(resolveApiKey(profile), 'env-key-mistral');
  } finally {
    if (prev === undefined) delete process.env.MISTRAL_API_KEY;
    else process.env.MISTRAL_API_KEY = prev;
  }
});

test('resolveApiKey returns empty string for ollama (no key needed)', () => {
  const profile: AgentProfile = { provider: 'ollama' };
  assert.equal(resolveApiKey(profile), '');
});

test('resolveApiKey throws when env var is absent for claude', () => {
  const profile: AgentProfile = { provider: 'claude' };
  const prev = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    assert.throws(
      () => resolveApiKey(profile),
      (err: unknown) => err instanceof Error && err.message.includes('ANTHROPIC_API_KEY'),
    );
  } finally {
    if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
  }
});

test('resolveApiKey throws when env var is absent for openai', () => {
  const profile: AgentProfile = { provider: 'openai' };
  const prev = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    assert.throws(
      () => resolveApiKey(profile),
      (err: unknown) => err instanceof Error && err.message.includes('OPENAI_API_KEY'),
    );
  } finally {
    if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
  }
});

test('resolveApiKey prefers explicit apiKey over env var', () => {
  const profile: AgentProfile = { provider: 'claude', apiKey: 'explicit' };
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'from-env';
  try {
    assert.equal(resolveApiKey(profile), 'explicit');
  } finally {
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prev;
  }
});

// ---------------------------------------------------------------------------
// cheapModelFor
// ---------------------------------------------------------------------------

test('cheapModelFor returns CHEAP_MODELS entry for claude', () => {
  assert.equal(cheapModelFor('claude'), CHEAP_MODELS.claude);
});

test('cheapModelFor returns CHEAP_MODELS entry for openai', () => {
  assert.equal(cheapModelFor('openai'), CHEAP_MODELS.openai);
});

test('cheapModelFor returns CHEAP_MODELS entry for gemini', () => {
  assert.equal(cheapModelFor('gemini'), CHEAP_MODELS.gemini);
});

test('cheapModelFor returns CHEAP_MODELS entry for mistral', () => {
  assert.equal(cheapModelFor('mistral'), CHEAP_MODELS.mistral);
});

test('cheapModelFor returns undefined for local providers (no cheap tier exists)', () => {
  // Local servers have no cheaper sibling to fall back to — the caller has to
  // decide what that means, which is why an explicit `fast` tier matters most
  // for llama.cpp/Ollama setups.
  assert.equal(CHEAP_MODELS.ollama, undefined);
  assert.equal(cheapModelFor('ollama'), undefined);
  assert.equal(cheapModelFor('llamacpp'), undefined);
});

// ---------------------------------------------------------------------------
// resolveAuth — OAuth logins
// ---------------------------------------------------------------------------

/** A scratch HOME plus a cleared env key, so these read the credential file
 *  this test wrote rather than the developer's own login or shell. */
function withLogin(creds: unknown | null, envKey: string, body: () => void): void {
  const home = mkdtempSync(join(tmpdir(), 'marshall-auth-'));
  const previousHome = process.env.HOME;
  const previousEnv = process.env[envKey];
  process.env.HOME = home;
  delete process.env[envKey];
  if (creds) {
    mkdirSync(join(home, '.marshall'), { recursive: true });
    writeFileSync(join(home, '.marshall', 'credentials.json'), JSON.stringify(creds));
  }
  try {
    body();
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousEnv === undefined) delete process.env[envKey]; else process.env[envKey] = previousEnv;
  }
}

const CODEX_LOGIN = {
  codex: { accessToken: 'oauth-token', refreshToken: 'r', expiresAt: Date.now() + 3_600_000, accountId: 'acct_3' },
};

test('a Codex login authenticates the codex provider, carrying its account id', () => {
  withLogin(CODEX_LOGIN, 'OPENAI_API_KEY', () => {
    assert.deepEqual(resolveAuth({ provider: 'codex' }), {
      key: 'oauth-token', authType: 'oauth', accountId: 'acct_3',
    });
  });
});

test('an expired Codex token still builds an agent — the SDK refreshes it per request', () => {
  withLogin({ codex: { accessToken: 'stale', refreshToken: 'r', expiresAt: Date.now() - 1 } }, 'OPENAI_API_KEY', () => {
    assert.equal(resolveAuth({ provider: 'codex' }).authType, 'oauth');
  });
});

test('OPENAI_API_KEY does not authenticate codex', () => {
  // Different product surface: a platform key is not accepted by the ChatGPT
  // backend, so falling back to it would only produce a confusing 401.
  withLogin(null, 'OPENAI_API_KEY', () => {
    process.env.OPENAI_API_KEY = 'sk-env';
    assert.throws(() => resolveAuth({ provider: 'codex' }), /login codex/);
  });
});

test('codex needs no key for the openai provider to keep working', () => {
  withLogin(CODEX_LOGIN, 'OPENAI_API_KEY', () => {
    process.env.OPENAI_API_KEY = 'sk-env';
    assert.deepEqual(resolveAuth({ provider: 'openai' }), { key: 'sk-env', authType: 'apiKey' });
  });
});

test('a Codex login does not authenticate any other provider', () => {
  withLogin(CODEX_LOGIN, 'MISTRAL_API_KEY', () => {
    assert.throws(() => resolveAuth({ provider: 'mistral' }), /No API key found for mistral/);
  });
});

test('no Codex credentials names both ways in', () => {
  withLogin(null, 'OPENAI_API_KEY', () => {
    assert.throws(() => resolveAuth({ provider: 'codex' }), /\/login codex.*codex login/s);
  });
});

test('the legacy flat credential file still signs in to Claude', () => {
  withLogin({ accessToken: 'claude-oauth', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 },
    'ANTHROPIC_API_KEY', () => {
      assert.deepEqual(resolveAuth({ provider: 'claude' }), { key: 'claude-oauth', authType: 'oauth' });
    });
});

test('every provider has a default model, including codex', () => {
  // A missing entry here is a runtime crash in `resolveModel`, and the type
  // only catches it while the Provider union and the table stay in step.
  for (const provider of Object.keys(PROVIDER_DEFAULTS) as Array<keyof typeof PROVIDER_DEFAULTS>) {
    assert.ok(PROVIDER_DEFAULTS[provider].model, `${provider} has no default model`);
  }
  assert.equal(PROVIDER_DEFAULTS.codex.envKey, null, 'codex is OAuth-only — there is no env key for it');
});
