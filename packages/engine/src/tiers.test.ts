import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTierProfile,
  resolveRoleProfile,
  tierForRole,
  isDelegated,
  DEFAULT_ROLE_TIERS,
  CHEAP_MODELS,
} from './config.js';
import type { EngineConfig, AgentProfile } from './config.js';

const KIMI: AgentProfile = { provider: 'openrouter', model: 'moonshotai/kimi-k3', apiKey: 'or-key' };
const LOCAL: AgentProfile = { provider: 'llamacpp', model: 'Gemma-4-E4B-MTP', host: 'http://192.168.1.248:8080' };

const base = (over: Partial<EngineConfig> = {}): EngineConfig => ({
  agent: KIMI,
  workspaceRoot: '/tmp/ws',
  ...over,
});

// ---------------------------------------------------------------------------
// tier resolution
// ---------------------------------------------------------------------------

test('deep falls back to config.agent when no tiers are configured', () => {
  assert.deepEqual(resolveTierProfile(base(), 'deep'), KIMI);
});

test('models.deep wins over config.agent', () => {
  const config = base({ models: { deep: LOCAL } });
  assert.deepEqual(resolveTierProfile(config, 'deep'), LOCAL);
});

test('fast tier crosses providers — hosted deep, local fast', () => {
  const config = base({ models: { deep: KIMI, fast: LOCAL } });
  assert.deepEqual(resolveTierProfile(config, 'deep'), KIMI);
  assert.deepEqual(resolveTierProfile(config, 'fast'), LOCAL);
});

test('each tier keeps its own auth and host', () => {
  const config = base({ models: { deep: KIMI, fast: LOCAL } });
  const fast = resolveTierProfile(config, 'fast');
  assert.equal(fast.apiKey, undefined, 'local tier must not inherit the hosted key');
  assert.equal(fast.host, 'http://192.168.1.248:8080');
  assert.equal(resolveTierProfile(config, 'deep').apiKey, 'or-key');
});

test('unconfigured fast degrades to a same-provider cheap model when one exists', () => {
  const config = base({ agent: { provider: 'claude' } });
  assert.equal(resolveTierProfile(config, 'fast').model, CHEAP_MODELS.claude);
});

test('unconfigured fast degrades to deep for local providers, which have no cheap tier', () => {
  const config = base({ agent: LOCAL });
  assert.deepEqual(resolveTierProfile(config, 'fast'), LOCAL);
});

// ---------------------------------------------------------------------------
// role → tier
// ---------------------------------------------------------------------------

test('roles use their default tier', () => {
  const config = base();
  assert.equal(tierForRole(config, 'coder'), 'deep');
  assert.equal(tierForRole(config, 'reviewer'), 'deep');
  assert.equal(tierForRole(config, 'context'), 'fast');
  assert.equal(tierForRole(config, 'summarizer'), 'fast');
});

test('roleTiers overrides the default binding', () => {
  const config = base({ roleTiers: { reviewer: 'fast', context: 'deep' } });
  assert.equal(tierForRole(config, 'reviewer'), 'fast');
  assert.equal(tierForRole(config, 'context'), 'deep');
  assert.equal(tierForRole(config, 'coder'), 'deep', 'untouched roles keep their default');
});

test('reading roles land on fast, deciding roles on deep', () => {
  const config = base({ models: { deep: KIMI, fast: LOCAL } });
  for (const role of ['coder', 'planner', 'reviewer'] as const) {
    assert.deepEqual(resolveRoleProfile(config, role), KIMI, role);
  }
  for (const role of ['context', 'search', 'summarizer'] as const) {
    assert.deepEqual(resolveRoleProfile(config, role), LOCAL, role);
  }
});

// ---------------------------------------------------------------------------
// precedence
// ---------------------------------------------------------------------------

test('roleProfiles pin beats the tier binding', () => {
  const pin: AgentProfile = { provider: 'claude', model: 'claude-haiku-4-5-20251001' };
  const config = base({ models: { deep: KIMI, fast: LOCAL }, roleProfiles: { search: pin } });
  assert.deepEqual(resolveRoleProfile(config, 'search'), pin);
  assert.deepEqual(resolveRoleProfile(config, 'context'), LOCAL, 'other fast roles are unaffected');
});

test('a pin beats a roleTiers override too', () => {
  const pin: AgentProfile = { provider: 'gemini', model: 'gemini-2.0-flash' };
  const config = base({
    models: { deep: KIMI, fast: LOCAL },
    roleTiers: { context: 'deep' },
    roleProfiles: { context: pin },
  });
  assert.deepEqual(resolveRoleProfile(config, 'context'), pin);
});

// ---------------------------------------------------------------------------
// backward compatibility — existing configs must resolve unchanged
// ---------------------------------------------------------------------------

test('legacy contextAgent still routes the context role', () => {
  const config = base({ contextAgent: LOCAL });
  assert.deepEqual(resolveRoleProfile(config, 'context'), LOCAL);
});

test('legacy plannerAgent and reviewerAgent still route their roles', () => {
  const config = base({ plannerAgent: LOCAL, reviewerAgent: LOCAL });
  assert.deepEqual(resolveRoleProfile(config, 'planner'), LOCAL);
  assert.deepEqual(resolveRoleProfile(config, 'reviewer'), LOCAL);
});

test('legacy searchAgent is honoured — it was previously declared but never read', () => {
  const config = base({ searchAgent: LOCAL });
  assert.deepEqual(resolveRoleProfile(config, 'search'), LOCAL);
});

test('legacy compressionModel applies as a model-only override on deep', () => {
  const config = base({ compressionModel: 'tiny-summariser' });
  const profile = resolveRoleProfile(config, 'summarizer');
  assert.equal(profile.provider, 'openrouter');
  assert.equal(profile.model, 'tiny-summariser');
  assert.equal(profile.apiKey, 'or-key', 'model-only override keeps the deep credentials');
});

test('roleProfiles pin beats the legacy field', () => {
  const pin: AgentProfile = { provider: 'mistral', model: 'mistral-small-latest' };
  const config = base({ contextAgent: LOCAL, roleProfiles: { context: pin } });
  assert.deepEqual(resolveRoleProfile(config, 'context'), pin);
});

test('a config with no tier settings resolves every role to the main agent', () => {
  // This is today's behaviour for local providers and must not drift.
  const config = base({ agent: LOCAL });
  for (const role of Object.keys(DEFAULT_ROLE_TIERS) as Array<keyof typeof DEFAULT_ROLE_TIERS>) {
    assert.deepEqual(resolveRoleProfile(config, role), LOCAL, role);
  }
});

// ---------------------------------------------------------------------------
// isDelegated — drives the "which tier ran this" UI tag
// ---------------------------------------------------------------------------

test('isDelegated is false when a role lands back on the deep model', () => {
  const config = base({ agent: LOCAL });
  assert.equal(isDelegated(config, 'context'), false);
  assert.equal(isDelegated(config, 'coder'), false);
});

test('isDelegated is true for a genuinely different model', () => {
  const config = base({ models: { deep: KIMI, fast: LOCAL } });
  assert.equal(isDelegated(config, 'context'), true);
  assert.equal(isDelegated(config, 'coder'), false);
});

test('isDelegated notices a same-provider host change', () => {
  const other: AgentProfile = { ...LOCAL, host: 'http://127.0.0.1:8080' };
  const config = base({ agent: LOCAL, models: { deep: LOCAL, fast: other } });
  assert.equal(isDelegated(config, 'context'), true);
});

test('isDelegated compares resolved models, not the raw field', () => {
  // Both resolve to the provider default; only one spells it out.
  const config = base({
    agent: { provider: 'claude' },
    models: { deep: { provider: 'claude' }, fast: { provider: 'claude', model: 'claude-sonnet-4-6' } },
  });
  assert.equal(isDelegated(config, 'context'), false);
});
