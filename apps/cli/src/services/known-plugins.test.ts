import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { browserSetupAvailable, extensionSetupNotice, loadExtensionSetupInstructions } from './known-plugins.js';
import { manualInstallCommand } from '../update-check.js';

describe('loadExtensionSetupInstructions', () => {
  it('finds the real export in the installed plugin', async () => {
    const fn = await loadExtensionSetupInstructions();
    assert.equal(typeof fn, 'function');
    const text = fn!({ paired: true });
    assert.ok(text.includes('/setup'));
  });

  it('returns null when the module cannot be loaded', async () => {
    assert.equal(await loadExtensionSetupInstructions(async () => { throw new Error('missing module'); }), null);
  });

  it('accepts an older plugin without the optional help export', async () => {
    assert.equal(await loadExtensionSetupInstructions(async () => ({ marshallPlugin: { name: 'browser' } })), null);
  });

  it('rejects a malformed export', async () => {
    assert.equal(await loadExtensionSetupInstructions(async () => ({ extensionSetupInstructions: 'not a function' })), null);
  });
});

describe('browserSetupAvailable', () => {
  it('checks the actual setup endpoint with a bounded, nonredirecting HEAD request', async () => {
    assert.equal(await browserSetupAvailable(9999, async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:9999/setup');
      assert.equal(options?.method, 'HEAD');
      assert.equal(options?.redirect, 'error');
      assert.ok(options?.signal);
      return new Response(null, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }), true);
  });

  it('rejects a legacy server without a setup route and non-HTML responses', async () => {
    assert.equal(await browserSetupAvailable(9999, async () => new Response(null, { status: 404 })), false);
    assert.equal(await browserSetupAvailable(9999, async () => new Response('{}', {
      headers: { 'content-type': 'application/json' },
    })), false);
  });

  it('degrades on connection failures and timeouts', async () => {
    assert.equal(await browserSetupAvailable(9999, async () => { throw new Error('unreachable'); }), false);
  });
});

describe('extensionSetupNotice', () => {
  it('delegates to the plugin when it can answer', () => {
    const text = extensionSetupNotice(() => 'GUIDED STEPS', { paired: false });
    assert.equal(text, 'GUIDED STEPS');
  });

  it('explains the way out when the installed plugin predates the export', () => {
    const text = extensionSetupNotice(null, { paired: false });
    assert.ok(text.includes('Browser plugin is running'));
    assert.ok(text.includes('guided setup help is unavailable'));
    assert.ok(text.includes(manualInstallCommand()), 'the upgrade command should be spelled out');
    assert.ok(text.includes('Restart marshall, then run /plugins add browser'));
    assert.ok(text.includes('docs.html#browser-extension'));
  });

  it('preserves help and upgrade guidance when the export throws', () => {
    const text = extensionSetupNotice(() => { throw new Error('broken help'); }, { paired: false });
    assert.ok(text.includes(manualInstallCommand()));
    assert.ok(text.includes('Browser plugin is running'));
  });

  it('passes pairing state through to the plugin', () => {
    for (const paired of [true, false]) {
      extensionSetupNotice(opts => {
        assert.equal(opts?.paired, paired);
        return 'steps';
      }, { paired });
    }
  });

  it('does not ask paired users for a token in the fallback', () => {
    const paired = extensionSetupNotice(null, { paired: true });
    assert.doesNotMatch(paired, /paste the pairing token/, 'a paired user was never shown a token to paste');
  });
});
