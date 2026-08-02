import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTierProfile,
  resolveRoleProfile,
  tierForRole,
  isDelegated,
  DEFAULT_ROLE_TIERS,
  CHEAP_MODELS,
  contextToolEnabled,
  routingSummary,
  resolveSearchProfile,
  resolveMaxTokens,
  DEFAULT_MAX_TOKENS,
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

// ---------------------------------------------------------------------------
// contextToolEnabled — configuring a fast tier is what turns tiering on
// ---------------------------------------------------------------------------

test('no tier config means no context tool', () => {
  assert.equal(contextToolEnabled(base()), false);
});

test('an explicit fast tier enables the context tool', () => {
  assert.equal(contextToolEnabled(base({ models: { deep: KIMI, fast: LOCAL } })), true);
});

test('a deep-only models block does not enable it', () => {
  assert.equal(contextToolEnabled(base({ models: { deep: LOCAL } })), false);
});

test('an auto-degraded fast tier does not enable it', () => {
  // claude has a CHEAP_MODELS entry, so resolveTierProfile('fast') differs from
  // deep — but the user never asked for tiering, so the toolbelt must not grow.
  const config = base({ agent: { provider: 'claude' } });
  assert.notEqual(resolveTierProfile(config, 'fast').model, resolveTierProfile(config, 'deep').model);
  assert.equal(contextToolEnabled(config), false);
});

test('the legacy contextAgent field still enables it', () => {
  assert.equal(contextToolEnabled(base({ contextAgent: LOCAL })), true);
});

test('a context roleProfiles pin enables it', () => {
  assert.equal(contextToolEnabled(base({ roleProfiles: { context: LOCAL } })), true);
});

// ---------------------------------------------------------------------------
// routingSummary — what the session logs, and what the UI tags
// ---------------------------------------------------------------------------

test('routingSummary covers every role exactly once', () => {
  const roles = routingSummary(base()).map(r => r.role).sort();
  assert.deepEqual(roles, Object.keys(DEFAULT_ROLE_TIERS).sort());
});

test('routingSummary splits deep and fast roles across providers', () => {
  const byRole = Object.fromEntries(
    routingSummary(base({ models: { deep: KIMI, fast: LOCAL } })).map(r => [r.role, r]),
  );
  assert.equal(byRole.coder.model, KIMI.model);
  assert.equal(byRole.coder.delegated, false);
  assert.equal(byRole.context.model, LOCAL.model);
  assert.equal(byRole.context.provider, 'llamacpp');
  assert.equal(byRole.context.delegated, true);
});

test('routingSummary reports nothing delegated when there is no fast tier', () => {
  assert.ok(routingSummary(base({ agent: LOCAL })).every(r => r.delegated === false));
});

// ---------------------------------------------------------------------------
// resolveSearchProfile — web search is claude-only and must survive a local
// fast tier, since that is the setup the tiering feature exists for
// ---------------------------------------------------------------------------

const CLAUDE: AgentProfile = { provider: 'claude', model: 'claude-opus-4-6', apiKey: 'k' };

test('search uses the fast tier when it can search', () => {
  const fastClaude: AgentProfile = { provider: 'claude', model: 'claude-haiku-4-5-20251001', apiKey: 'k' };
  const config = base({ agent: CLAUDE, models: { deep: CLAUDE, fast: fastClaude } });
  assert.deepEqual(resolveSearchProfile(config), fastClaude);
});

test('search falls back to deep when the fast tier is local', () => {
  const config = base({ agent: CLAUDE, models: { deep: CLAUDE, fast: LOCAL } });
  assert.deepEqual(resolveSearchProfile(config), CLAUDE);
});

test('search is unavailable when no tier is claude', () => {
  assert.equal(resolveSearchProfile(base({ agent: LOCAL, models: { deep: LOCAL, fast: LOCAL } })), null);
  assert.equal(resolveSearchProfile(base()), null, 'openrouter deep cannot search either');
});

// ---------------------------------------------------------------------------
// /plan and /review run on the deep tier — they are deciding roles, and a
// "llama.cpp error" from them is really OpenRouter, which shares the class
// ---------------------------------------------------------------------------

test('planner and reviewer stay on deep even with a local fast tier', () => {
  const config = base({ agent: KIMI, models: { deep: KIMI, fast: LOCAL } });
  assert.deepEqual(resolveRoleProfile(config, 'planner'), KIMI);
  assert.deepEqual(resolveRoleProfile(config, 'reviewer'), KIMI);
  assert.equal(isDelegated(config, 'reviewer'), false, '/review must not be tagged as delegated');
});

// ---------------------------------------------------------------------------
// resolveMaxTokens — a fixed cap was turning long-but-valid answers into
// "Response exceeded maximum token limit"
// ---------------------------------------------------------------------------

test('hosted providers send no cap, so the model uses its own ceiling', () => {
  assert.equal(resolveMaxTokens(KIMI), undefined);
  assert.equal(resolveMaxTokens({ provider: 'openai' }), undefined);
});

test('local servers keep a ceiling — uncapped they generate until context runs out', () => {
  assert.equal(resolveMaxTokens(LOCAL), 32768);
  assert.equal(resolveMaxTokens({ provider: 'ollama' }), 32768);
});

test('the cap is per profile, so a hosted deep and local fast differ', () => {
  const config = base({ agent: KIMI, models: { deep: KIMI, fast: LOCAL } });
  assert.equal(resolveMaxTokens(resolveRoleProfile(config, 'coder')), undefined);
  assert.equal(resolveMaxTokens(resolveRoleProfile(config, 'context')), 32768);
});

test('claude still gets a cap, since Anthropic rejects requests without one', () => {
  assert.equal(resolveMaxTokens({ provider: 'claude' }), DEFAULT_MAX_TOKENS);
});

test('an explicit cap wins everywhere', () => {
  assert.equal(resolveMaxTokens(KIMI, 32000), 32000);
  assert.equal(resolveMaxTokens({ provider: 'claude' }, 32000), 32000);
});

test('zero means omit, but claude keeps its required fallback', () => {
  assert.equal(resolveMaxTokens(KIMI, 0), undefined);
  assert.equal(resolveMaxTokens({ provider: 'claude' }, 0), DEFAULT_MAX_TOKENS);
});
