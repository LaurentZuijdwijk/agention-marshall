import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProfiles, chosenProfile, StartupError } from './profiles.js';
import { parseCliArgs } from './args.js';
import type { CliFlags } from './args.js';
import type { SavedConfig } from '../services/config-store.js';
import type { AgentProfile } from '@agentionai/marshall-engine';

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

  it('drops the saved endpoint name when a CLI flag switches to a different provider', () => {
    // The saved deep tier is a named openai-compatible endpoint. Overriding the
    // provider on the CLI must not carry that name onto the new provider — the
    // name identifies an endpoint that belongs to the old one, and describes a
    // server the new provider was never pointed at.
    const config: SavedConfig = {
      models: { deep: { provider: 'openai-compatible', name: 'LM Studio', model: 'llama-3' } },
    };
    const { agentProfile } = resolveProfiles(flags({ provider: 'claude' }), config);
    assert.strictEqual(agentProfile.provider, 'claude');
    assert.strictEqual(agentProfile.name, undefined);
  });

  it('keeps the saved endpoint name when the provider is not overridden', () => {
    const config: SavedConfig = {
      models: { deep: { provider: 'openai-compatible', name: 'LM Studio', model: 'llama-3' } },
    };
    const { agentProfile } = resolveProfiles(flags(), config);
    assert.strictEqual(agentProfile.provider, 'openai-compatible');
    assert.strictEqual(agentProfile.name, 'LM Studio');
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

  // `withModelSelection` (config-store.ts) never writes an apiKey into the
  // saved model selection — the credential lives only in `providers[]`. Both
  // branches of the fast tier's key resolution have to reach for it there,
  // not for a key `models.deep`/`models.fast` no longer carries.
  it('finds the key in the provider entry when the saved profiles carry none', () => {
    const shared: SavedConfig = {
      models: { deep: { provider: 'openrouter', model: 'kimi' } },
      providers: [{ provider: 'openrouter', apiKey: 'router-key' }],
    };
    const { fastProfile } = resolveProfiles(flags({ fastModel: 'small' }), shared);
    assert.strictEqual(fastProfile?.apiKey, 'router-key',
      'a same-provider fast tier must still authenticate once the deep tier does');

    const split: SavedConfig = {
      models: { deep: { provider: 'openrouter', model: 'kimi' } },
      providers: [
        { provider: 'openrouter', apiKey: 'router-key' },
        { provider: 'llamacpp', host: 'http://box:8080', apiKey: 'box-key' },
      ],
    };
    const { fastProfile: splitFast } = resolveProfiles(
      flags({ fastProvider: 'llamacpp', fastModel: 'small' }), split,
    );
    assert.strictEqual(splitFast?.apiKey, 'box-key',
      'a split fast tier looks up its own provider’s entry, not the deep tier’s');
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
    // `reasoningEffort` is present-but-undefined, like `model`/`apiKey`/`host`
    // when those are unset: resolveProfiles always writes the key. deepStrictEqual
    // tells that apart from an absent key, so it has to be spelled out here.
    assert.deepStrictEqual(plannerAgentProfile, {
      provider: 'openai', model: 'o3-mini', apiKey: 'k', host: 'http://h',
      reasoningEffort: undefined,
    });
  });

  it('leaves roles unset when no override is given', () => {
    const resolved = resolveProfiles(flags(), {});
    assert.strictEqual(resolved.contextAgentProfile, undefined);
    assert.strictEqual(resolved.plannerAgentProfile, undefined);
    assert.strictEqual(resolved.reviewerAgentProfile, undefined);
  });

  it('sets an output budget only when the user asked for one', () => {
    // The session carries one number, so a default picked here would apply to
    // every tier — a local deep tier's 32768 handed to a hosted fast tier.
    // Absent, the engine resolves the cap per profile instead.
    assert.strictEqual(resolveProfiles(flags({ provider: 'llamacpp' }), {}).maxTokens, undefined);
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

  it('leaves --light undefined when absent, so the config still has a say', () => {
    assert.strictEqual(parseCliArgs([]).light, undefined);
    assert.strictEqual(parseCliArgs(['--light']).light, true);
  });

  it('maps kebab-case flags onto camelCase fields', () => {
    const parsed = parseCliArgs(['--fast-model', 'small', '--fast-host', 'http://box:8080', '--reviewer-model', 'r']);
    assert.strictEqual(parsed.fastModel, 'small');
    assert.strictEqual(parsed.fastHost, 'http://box:8080');
    assert.strictEqual(parsed.reviewerModel, 'r');
  });
});

// The interactive counterpart to `resolveProfiles` above: what the setup
// wizard or settings menu produces when it replaces one tier's endpoint.
describe('chosenProfile', () => {
  it('is undefined for the fast tier\'s "same as deep" row', () => {
    assert.strictEqual(chosenProfile({ provider: null, model: null }), undefined);
  });

  it('builds a profile from a full choice', () => {
    const profile = chosenProfile({
      provider: 'llamacpp', model: 'local', host: 'http://box:8080', apiKey: 'k',
    });
    assert.deepStrictEqual(profile, { provider: 'llamacpp', model: 'local', host: 'http://box:8080', apiKey: 'k' });
  });

  it('does not carry a name onto a different provider than the one it was saved under', () => {
    // The regression this exists for: switching to an unnamed llamacpp entry
    // used to keep a previous named openai-compatible endpoint's name, which
    // mislabelled the header and got persisted back into the saved config.
    const profile = chosenProfile({ provider: 'llamacpp', model: 'local' });
    assert.strictEqual(profile?.name, undefined);
  });

  it('keeps the name the wizard actually returned', () => {
    const profile = chosenProfile({ provider: 'openai-compatible', model: 'llama-3', name: 'LM Studio' });
    assert.strictEqual(profile?.name, 'LM Studio');
  });

  it('carries reasoningEffort only from the profile explicitly named to carry it from', () => {
    const previous: AgentProfile = { provider: 'openai', model: 'gpt-4o', reasoningEffort: 'high' };
    const withCarry = chosenProfile({ provider: 'llamacpp', model: 'local' }, previous);
    assert.strictEqual(withCarry?.reasoningEffort, 'high');

    const withoutCarry = chosenProfile({ provider: 'llamacpp', model: 'local' });
    assert.strictEqual(withoutCarry?.reasoningEffort, undefined);
  });

  it('does not carry host or apiKey from the previous profile', () => {
    // Those describe the endpoint being left, not the one just chosen — unlike
    // reasoningEffort, which is a preference rather than a connection detail.
    const previous: AgentProfile = {
      provider: 'openai-compatible', model: 'old', host: 'http://old', apiKey: 'old-key',
    };
    const profile = chosenProfile({ provider: 'llamacpp', model: 'local' }, previous);
    assert.strictEqual(profile?.host, undefined);
    assert.strictEqual(profile?.apiKey, undefined);
  });
});
