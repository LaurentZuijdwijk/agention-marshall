import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { filterOpenAIModels, discoverModels, MODEL_PRESETS, providerHasHost } from './modelCatalog.js';
import type { ModelInfo } from '@agentionai/marshall-engine';

describe('filterOpenAIModels', () => {
  it('keeps recent conversational models and excludes non-text API models', () => {
    const models: ModelInfo[] = [
      { id: 'text-embedding-3-small' },
      { id: 'gpt-5' },
      { id: 'gpt-4o-mini' },
      { id: 'dall-e-3' },
      { id: 'whisper-1' },
      { id: 'o3-mini' },
    ];
    assert.deepEqual(filterOpenAIModels(models).map(model => model.id), [
      'gpt-5', 'gpt-4o-mini', 'o3-mini',
    ]);
  });

  it('keeps and prioritizes decimal model versions', () => {
    const models: ModelInfo[] = [
      { id: 'gpt-5.4-mini' },
      { id: 'gpt-5.6' },
      { id: 'text-embedding-3-large' },
    ];
    assert.deepEqual(filterOpenAIModels(models).map(model => model.id), [
      'gpt-5.6', 'gpt-5.4-mini',
    ]);
  });

  it('offers the default OpenAI models when discovery is unavailable', () => {
    assert.deepEqual(MODEL_PRESETS.openai, [
      'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra',
    ]);
  });
});

describe('providerHasHost', () => {
  it('asks for a URL only for the local servers', () => {
    assert.equal(providerHasHost('ollama'), true);
    assert.equal(providerHasHost('llamacpp'), true);
    // OpenRouter has a fixed gateway in its defaults — nothing to type.
    assert.equal(providerHasHost('openrouter'), false);
    assert.equal(providerHasHost('claude'), false);
  });
});

describe('discoverModels', () => {
  // A hosted provider with no key can't be queried at all, so this exercises
  // the fallback path without touching the network.
  it('falls back to the presets and says so when there is nothing to query with', async () => {
    const catalogue = await discoverModels('claude', '', undefined);
    assert.deepEqual(catalogue.models.map(model => model.id), MODEL_PRESETS.claude);
    assert.deepEqual(catalogue.note, ['claude unreachable — showing defaults']);
  });

  it('names the host, not the provider, when a local server is the one that failed', async () => {
    const catalogue = await discoverModels('ollama', 'http://127.0.0.1:1', undefined);
    assert.deepEqual(catalogue.models.map(model => model.id), MODEL_PRESETS.ollama);
    assert.deepEqual(catalogue.note, ['http://127.0.0.1:1 unreachable — showing defaults']);
  });
});
