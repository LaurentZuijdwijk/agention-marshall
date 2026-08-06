import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isNewer, describeUpdate, manualInstallCommand, checkForUpdate } from './update-check.js';

describe('isNewer', () => {
  it('compares fields numerically, not as strings', () => {
    assert.ok(isNewer('0.10.0', '0.9.0'), '0.10.0 is a later release than 0.9.0');
    assert.ok(!isNewer('0.9.0', '0.10.0'));
  });

  it('is false for the same version', () => {
    assert.ok(!isNewer('1.2.3', '1.2.3'));
  });

  it('is false when the local build is ahead of the registry', () => {
    assert.ok(!isNewer('0.1.0', '0.2.0'));
  });

  it('ranks each field in order', () => {
    assert.ok(isNewer('1.0.0', '0.99.99'));
    assert.ok(isNewer('1.1.0', '1.0.99'));
    assert.ok(isNewer('1.1.2', '1.1.1'));
  });

  it('treats a missing field as zero', () => {
    assert.ok(isNewer('1.1', '1.0.9'));
    assert.ok(!isNewer('1.0', '1.0.0'));
  });

  it('does not treat a prerelease as newer than its release', () => {
    assert.ok(!isNewer('1.2.0-beta.1', '1.2.0'));
  });
});

describe('describeUpdate', () => {
  it('names both versions', () => {
    assert.match(describeUpdate({ current: '1.0.0', latest: '2.0.0' }), /1\.0\.0 → 2\.0\.0/);
  });

  it('does not say how to install — the caller decides that', () => {
    // The startup row points at `/update`; `/update` itself is already
    // installing. A baked-in instruction always read wrong for one of them.
    assert.doesNotMatch(describeUpdate({ current: '1.0.0', latest: '2.0.0' }), /npm install/);
  });
});

describe('manualInstallCommand', () => {
  it('is a command the user can paste when the automatic install fails', () => {
    assert.equal(manualInstallCommand('@agentionai/marshall-cli'),
      'npm install -g @agentionai/marshall-cli@latest');
  });
});

describe('checkForUpdate', () => {
  const realFetch = globalThis.fetch;
  const stubFetch = (impl: () => Promise<unknown>) => {
    globalThis.fetch = impl as typeof globalThis.fetch;
  };

  it('returns null when the registry errors', async () => {
    stubFetch(async () => ({ ok: false, status: 500 }));
    try {
      assert.equal(await checkForUpdate(), null);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('returns null when the network is unavailable', async () => {
    stubFetch(async () => { throw new Error('ENOTFOUND'); });
    try {
      assert.equal(await checkForUpdate(), null);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('reports the version pair when the registry is ahead', async () => {
    stubFetch(async () => ({ ok: true, json: async () => ({ version: '99.0.0' }) }));
    try {
      assert.deepEqual(await checkForUpdate('1.2.3'), { current: '1.2.3', latest: '99.0.0' });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('returns null when the local build is ahead of the registry', async () => {
    stubFetch(async () => ({ ok: true, json: async () => ({ version: '0.1.0' }) }));
    try {
      assert.equal(await checkForUpdate('9.9.9'), null,
        'a dev build ahead of the registry must not be told to "update" backwards');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
