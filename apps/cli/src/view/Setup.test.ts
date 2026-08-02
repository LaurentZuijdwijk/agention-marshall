import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { seedHost } from './Setup.js';

describe('seedHost', () => {
  it('uses the provider’s own last-used host', () => {
    assert.equal(
      seedHost('llamacpp', { llamacpp: 'http://box:8080' }, undefined),
      'http://box:8080',
    );
  });

  it('falls back to the built-in default for a provider never used before', () => {
    assert.equal(seedHost('ollama', {}, undefined), 'http://localhost:11434');
    assert.equal(seedHost('llamacpp', {}, undefined), 'http://localhost:8080');
  });

  it('keeps the session host when the provider is unchanged', () => {
    // The flat pre-tier config shape: one host, belonging to the session's own
    // provider. Re-picking that provider must not lose it.
    assert.equal(
      seedHost('llamacpp', {}, { provider: 'llamacpp', host: 'http://box:8080' }),
      'http://box:8080',
    );
  });

  it('does not carry one provider’s host over to another', () => {
    assert.equal(
      seedHost('ollama', {}, { provider: 'llamacpp', host: 'http://box:8080' }),
      'http://localhost:11434',
      'seeding ollama with a llama.cpp URL probes the wrong server',
    );
  });

  it('prefers a saved host over the session one', () => {
    assert.equal(
      seedHost('llamacpp', { llamacpp: 'http://saved:8080' }, { provider: 'llamacpp', host: 'http://session:8080' }),
      'http://saved:8080',
    );
  });

  it('is empty for providers that take no host', () => {
    assert.equal(seedHost('claude', {}, undefined), '');
    assert.equal(seedHost('openai', {}, { provider: 'llamacpp', host: 'http://box:8080' }), '');
  });

  it('still offers a saved gateway for openrouter', () => {
    assert.equal(
      seedHost('openrouter', { openrouter: 'http://gateway/v1' }, undefined),
      'http://gateway/v1',
    );
    assert.equal(seedHost('openrouter', {}, undefined), 'https://openrouter.ai/api/v1');
  });
});
