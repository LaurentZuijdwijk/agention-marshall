import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProfiles, StartupError } from './profiles.js';
import { parseCliArgs } from './args.js';
import type { CliFlags } from './args.js';
import type { SavedConfig } from '../services/config-store.js';

/** Flags as if nothing was passed, so each test states only what it varies. */
function flags(overrides: Partial<CliFlags> = {}): CliFlags {
  return { ...parseCliArgs([]), ...overrides };
}

describe('resolveProfiles — deep tier', () => {
  it('defaults to claude with no flags and no config', () => {
    const { agentProfile } = resolveProfiles(flags(), {});
    assert.strictEqual(agentProfile.provider, 'claude');
    assert.strictEqual(agentProfile.model, undefined);
  });

  it('leaves the model undefined so first run lands in the setup wizard', () => {
    const { agentProfile } = resolveProfiles(flags({ provider: 'ollama' }), {});
    assert.strictEqual(agentProfile.model, undefined);
  });

  it('reads the pre-tier flat config keys as the deep tier', () => {
    const config: SavedConfig = { provider: 'openai', model: 'gpt-4o', apiKey: 'flat-key' };
    const { agentProfile } = resolveProfiles(flags(), config);
    assert.strictEqual(agentProfile.provider, 'openai');
    assert.strictEqual(agentProfile.model, 'gpt-4o');
    assert.strictEqual(agentProfile.apiKey, 'flat-key');
  });

  it('prefers models.deep over the flat keys', () => {
    const config: SavedConfig = {
      provider: 'openai', model: 'gpt-4o',
      models: { deep: { provider: 'mistral', model: 'codestral-latest' } },
    };
    const { agentProfile } = resolveProfiles(flags(), config);
    assert.strictEqual(agentProfile.provider, 'mistral');
    assert.strictEqual(agentProfile.model, 'codestral-latest');
  });

  it('lets CLI flags win over saved config', () => {
    const config: SavedConfig = { models: { deep: { provider: 'openai', model: 'gpt-4o', host: 'http://saved' } } };
    const { agentProfile } = resolveProfiles(flags({ provider: 'llamacpp', model: 'local', host: 'http://cli' }), config);
    assert.strictEqual(agentProfile.provider, 'llamacpp');
    assert.strictEqual(agentProfile.model, 'local');
    assert.strictEqual(agentProfile.host, 'http://cli');
  });

  it('falls back to the provider entry for host and key', () => {
    const config: SavedConfig = {
      models: { deep: { provider: 'llamacpp', model: 'local' } },
      providers: [{ provider: 'llamacpp', host: 'http://192.168.1.248:8080', apiKey: 'entry-key' }],
    };
    const { agentProfile } = resolveProfiles(flags(), config);
    assert.strictEqual(agentProfile.host, 'http://192.168.1.248:8080');
    assert.strictEqual(agentProfile.apiKey, 'entry-key');
  });

  it('rejects an unknown provider', () => {
    assert.throws(() => resolveProfiles(flags({ provider: 'gpt5' }), {}), StartupError);
  });
});

describe('resolveProfiles — fast tier', () => {
  it('is absent without a fast model', () => {
    assert.strictEqual(resolveProfiles(flags({ fastProvider: 'ollama' }), {}).fastProfile, undefined);
  });

  it('inherits the deep provider and host when none is given', () => {
    const config: SavedConfig = { models: { deep: { provider: 'llamacpp', model: 'big', host: 'http://box:8080' } } };
    const { fastProfile } = resolveProfiles(flags({ fastModel: 'small' }), config);
    assert.strictEqual(fastProfile?.provider, 'llamacpp');
    assert.strictEqual(fastProfile?.host, 'http://box:8080');
  });

  it('inherits the deep key only when the tiers share a provider', () => {
    const shared = resolveProfiles(flags({ apiKey: 'deep-key', fastModel: 'small' }), {});
    assert.strictEqual(shared.fastProfile?.apiKey, 'deep-key');

    const split = resolveProfiles(
      flags({ apiKey: 'deep-key', fastProvider: 'llamacpp', fastModel: 'small' }),
      {},
    );
    assert.strictEqual(split.fastProfile?.apiKey, undefined,
      'a local fast tier must not receive the hosted provider’s credentials');
  });

  it('takes a split tier’s host from that provider’s saved entry', () => {
    const config: SavedConfig = {
      models: { deep: { provider: 'openrouter', model: 'kimi' } },
      providers: [{ provider: 'llamacpp', host: 'http://box:8080' }],
    };
    const { fastProfile } = resolveProfiles(flags({ fastProvider: 'llamacpp', fastModel: 'small' }), config);
    assert.strictEqual(fastProfile?.host, 'http://box:8080');
  });

  it('does not leak the deep host to a different provider', () => {
    const config: SavedConfig = { models: { deep: { provider: 'openrouter', model: 'kimi', host: 'http://gateway' } } };
    const { fastProfile } = resolveProfiles(flags({ fastProvider: 'ollama', fastModel: 'small' }), config);
    assert.strictEqual(fastProfile?.host, undefined);
  });

  it('rejects an unknown fast provider even with no fast model', () => {
    assert.throws(() => resolveProfiles(flags({ fastProvider: 'nope' }), {}), StartupError);
  });
});

describe('resolveProfiles — roles and limits', () => {
  it('reuses the deep provider, key and host for role overrides', () => {
    const config: SavedConfig = { models: { deep: { provider: 'openai', model: 'gpt-4o', apiKey: 'k', host: 'http://h' } } };
    const { plannerAgentProfile } = resolveProfiles(flags({ plannerModel: 'o3-mini' }), config);
    assert.deepStrictEqual(plannerAgentProfile, {
      provider: 'openai', model: 'o3-mini', apiKey: 'k', host: 'http://h',
    });
  });

  it('leaves roles unset when no override is given', () => {
    const resolved = resolveProfiles(flags(), {});
    assert.strictEqual(resolved.contextAgentProfile, undefined);
    assert.strictEqual(resolved.plannerAgentProfile, undefined);
    assert.strictEqual(resolved.reviewerAgentProfile, undefined);
  });

  it('gives local providers a larger default output budget', () => {
    assert.strictEqual(resolveProfiles(flags({ provider: 'llamacpp' }), {}).maxTokens, 32768);
    assert.strictEqual(resolveProfiles(flags({ provider: 'claude' }), {}).maxTokens, undefined);
    assert.strictEqual(resolveProfiles(flags({ provider: 'llamacpp', maxTokens: '4096' }), {}).maxTokens, 4096);
  });
});

describe('parseCliArgs', () => {
  it('reads long flags, short flags and the positional workspace', () => {
    const parsed = parseCliArgs(['-p', 'openai', '--model', 'gpt-4o', '/tmp/ws']);
    assert.strictEqual(parsed.provider, 'openai');
    assert.strictEqual(parsed.model, 'gpt-4o');
    assert.strictEqual(parsed.workspace, '/tmp/ws');
  });

  it('treats web search as on unless disabled', () => {
    assert.strictEqual(parseCliArgs([]).webSearch, true);
    assert.strictEqual(parseCliArgs(['--no-web-search']).webSearch, false);
  });

  it('maps kebab-case flags onto camelCase fields', () => {
    const parsed = parseCliArgs(['--fast-model', 'small', '--fast-host', 'http://box:8080', '--reviewer-model', 'r']);
    assert.strictEqual(parsed.fastModel, 'small');
    assert.strictEqual(parsed.fastHost, 'http://box:8080');
    assert.strictEqual(parsed.reviewerModel, 'r');
  });
});
