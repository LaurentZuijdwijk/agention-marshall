import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveModel,
  resolveApiKey,
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

test('cheapModelFor falls back to PROVIDER_DEFAULTS model for ollama (no cheap model defined)', () => {
  // ollama has no entry in CHEAP_MODELS
  assert.equal(CHEAP_MODELS.ollama, undefined);
  assert.equal(cheapModelFor('ollama'), PROVIDER_DEFAULTS.ollama.model);
});
