import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { seedHost, resolveKeyInput, keyStepText } from './Setup.js';

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

describe('resolveKeyInput', () => {
  // The reported bug: with a key already in the config, enter on an empty
  // field did nothing, so the only way past the step was to retype a secret.
  it('falls back to the stored key on an empty submit', () => {
    assert.equal(resolveKeyInput('', 'sk-stored'), 'sk-stored');
    assert.equal(resolveKeyInput('   ', 'sk-stored'), 'sk-stored');
  });

  it('lets a typed key replace the stored one', () => {
    assert.equal(resolveKeyInput('sk-new', 'sk-stored'), 'sk-new');
  });

  it('trims what was typed', () => {
    assert.equal(resolveKeyInput('  sk-new  ', undefined), 'sk-new');
  });

  // Nothing typed and nothing stored means there is genuinely no key, so the
  // caller keeps the user on the step rather than starting an unusable session.
  it('returns undefined when there is nothing to go on', () => {
    assert.equal(resolveKeyInput('', undefined), undefined);
    assert.equal(resolveKeyInput('  ', ''), undefined);
  });
});

describe('keyStepText', () => {
  const SECRET = 'sk-or-v1-0123456789abcdef0123456789abcdef';

  it('never puts the stored key on screen', () => {
    const { placeholder, hint } = keyStepText('OPENROUTER_API_KEY', SECRET);
    assert.doesNotMatch(placeholder, /sk-or/);
    assert.doesNotMatch(hint, /sk-or/);
  });

  // Showing the last few characters is the tempting "helpful" change. This text
  // is on screen during screen shares and stays in terminal scrollback, and a
  // suffix is enough to confirm a guessed key.
  it('does not leak even a fragment of the stored key', () => {
    const { placeholder, hint } = keyStepText('OPENROUTER_API_KEY', SECRET);
    for (const n of [4, 6, 8]) {
      assert.doesNotMatch(placeholder, new RegExp(SECRET.slice(-n)));
      assert.doesNotMatch(hint, new RegExp(SECRET.slice(-n)));
      assert.doesNotMatch(placeholder, new RegExp(SECRET.slice(0, n)));
      assert.doesNotMatch(hint, new RegExp(SECRET.slice(0, n)));
    }
  });

  it('names the env var, which is a name and not a value', () => {
    assert.match(keyStepText('OPENROUTER_API_KEY', SECRET).placeholder, /OPENROUTER_API_KEY/);
    assert.match(keyStepText('OPENROUTER_API_KEY', undefined).hint, /OPENROUTER_API_KEY/);
  });

  it('says enter keeps the key only when one is actually stored', () => {
    assert.match(keyStepText('X', SECRET).hint, /keeps the stored key/);
    assert.doesNotMatch(keyStepText('X', undefined).hint, /keeps the stored key/);
  });

  it('treats an empty stored key as none, so the hint cannot promise nothing', () => {
    assert.doesNotMatch(keyStepText('X', '').hint, /keeps the stored key/);
  });
});
