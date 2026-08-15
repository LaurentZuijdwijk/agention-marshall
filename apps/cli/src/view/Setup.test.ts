import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { Setup, seedHost, resolveKeyInput, keyStepText } from './Setup.js';
import { providerCredentials } from '../services/config-store.js';
import type { SavedProviderEntry } from '../services/config-store.js';
import { fakeStdin, fakeStdout, renderTui, waitFor } from '../testing/ink.js';

/** The lookup the App passes in, over a given set of stored entries. */
const stored = (...entries: SavedProviderEntry[]) =>
  (ref: { provider: string; name?: string }) => providerCredentials(entries, ref);
const none = stored();

describe('seedHost', () => {
  it('uses the provider’s own last-used host', () => {
    assert.equal(
      seedHost({ provider: 'llamacpp' }, stored({ provider: 'llamacpp', host: 'http://box:8080' }), undefined),
      'http://box:8080',
    );
  });

  it('falls back to the built-in default for a provider never used before', () => {
    assert.equal(seedHost({ provider: 'ollama' }, none, undefined), 'http://localhost:11434');
    assert.equal(seedHost({ provider: 'llamacpp' }, none, undefined), 'http://localhost:8080');
  });

  it('keeps the session host when the provider is unchanged', () => {
    // The flat pre-tier config shape: one host, belonging to the session's own
    // provider. Re-picking that provider must not lose it.
    assert.equal(
      seedHost({ provider: 'llamacpp' }, none, { provider: 'llamacpp', host: 'http://box:8080' }),
      'http://box:8080',
    );
  });

  it('does not carry one provider’s host over to another', () => {
    assert.equal(
      seedHost({ provider: 'ollama' }, none, { provider: 'llamacpp', host: 'http://box:8080' }),
      'http://localhost:11434',
      'seeding ollama with a llama.cpp URL probes the wrong server',
    );
  });

  it('prefers a saved host over the session one', () => {
    assert.equal(
      seedHost({ provider: 'llamacpp' }, stored({ provider: 'llamacpp', host: 'http://saved:8080' }),
        { provider: 'llamacpp', host: 'http://session:8080' }),
      'http://saved:8080',
    );
  });

  it('is empty for providers that take no host', () => {
    assert.equal(seedHost({ provider: 'claude' }, none, undefined), '');
    assert.equal(seedHost({ provider: 'openai' }, none, { provider: 'llamacpp', host: 'http://box:8080' }), '');
  });

  it('still offers a saved gateway for openrouter', () => {
    assert.equal(
      seedHost({ provider: 'openrouter' }, stored({ provider: 'openrouter', host: 'http://gateway/v1' }), undefined),
      'http://gateway/v1',
    );
    assert.equal(seedHost({ provider: 'openrouter' }, none, undefined), 'https://openrouter.ai/api/v1');
  });

  // One `openai-compatible` config can be three different servers. Seeding the
  // one being configured from whichever entry happened to be first is how the
  // wizard offered LM Studio's address for a different machine entirely.
  it('seeds a named endpoint from its own entry, not the provider’s first', () => {
    const entries = stored(
      { provider: 'openai-compatible', host: 'http://plain' },
      { provider: 'openai-compatible', name: 'LM Studio', host: 'http://lm' },
    );
    assert.equal(seedHost({ provider: 'openai-compatible', name: 'LM Studio' }, entries, undefined),
      'http://lm');
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

// ── the wizard itself, driven through a fake TTY ─────────────────────────────

describe('Setup wizard', () => {
  // Regression: on a named endpoint, the custom-model path dropped the name, so
  // the profile was saved under the *unnamed* `openai-compatible` entry and
  // that entry's host and key were clobbered by the named one's.
  it('passes the endpoint name through the custom-model step', async () => {
    const calls: Array<[string | null, string | null, string?, string?, string?]> = [];
    const captured: string[] = [];
    const stream = fakeStdout(chunk => { captured.push(chunk); });
    const stdin = fakeStdin();
    // ANSI colour codes sit between the cursor marker and the row label, so the
    // waits match the visible text, not the raw bytes.
    const visible = () => captured.join('').replace(/\u001B\[[0-9;]*m/g, '');
    const waitVisible = (text: string, what: string) =>
      waitFor(() => visible().includes(text), what);

    const instance = renderTui(
      React.createElement(Setup, {
        credentials: stored({ provider: 'openai-compatible', name: 'LM Studio', host: 'http://127.0.0.1:9' }),
        customProviders: [{ name: 'LM Studio', host: 'http://127.0.0.1:9' }],
        onComplete: (provider: string | null, model: string | null, host?: string, apiKey?: string, name?: string) => {
          calls.push([provider, model, host, apiKey, name]);
        },
      }),
      { stdout: stream, stdin },
    );

    try {
      // Provider: one up-arrow wraps to the last row, the named endpoint.
      await waitVisible('LM Studio', 'the provider list');
      stdin.push('\u001B[A');
      await waitVisible('❯ LM Studio', 'the cursor on the named endpoint');
      stdin.push('\r');

      // Host: seeded from the named entry's own stored host; confirm it.
      await waitVisible('server URL', 'the host step');
      stdin.push('\r');

      // Key: type one.
      await waitVisible('openai-compatible  ·  API key', 'the key step');
      stdin.push('sk-test');
      await waitVisible('*****', 'the key masked on screen');
      stdin.push('\r');

      // Endpoint name: seeded from the row picked on the provider step; confirm it.
      await waitVisible('endpoint name', 'the endpoint-name step');
      stdin.push('\r');

      // Model: the unreachable server degrades to the preset list, which for
      // `openai-compatible` is just the custom row — enter selects it.
      await waitVisible('showing defaults', 'the model list');
      stdin.push('\r');

      // Custom: type an ID the list does not have.
      await waitVisible('enter model ID', 'the custom step');
      stdin.push('my-model');
      await waitVisible('my-model', 'the typed model ID');
      stdin.push('\r');

      await waitFor(() => calls.length === 1, 'onComplete');
      assert.deepEqual(calls, [
        ['openai-compatible', 'my-model', 'http://127.0.0.1:9', 'sk-test', 'LM Studio'],
      ], 'the endpoint name must survive the custom-model step');
    } finally {
      instance.unmount();
    }
  });
});
