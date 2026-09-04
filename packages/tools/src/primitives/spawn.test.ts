import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubbedEnv } from './spawn.js';

const MARKER = 'MARSHALL_INJECTED_NODE_ENV';

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { fn(); } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('the allowlist forwards a NODE_ENV the user set', () => {
  withEnv({ NODE_ENV: 'staging', [MARKER]: undefined }, () => {
    assert.equal(scrubbedEnv().NODE_ENV, 'staging',
      "a NODE_ENV the user exported describes their project and must reach their commands");
  });
});

// The CLI re-execs itself with NODE_ENV=production so Ink loads React's
// production reconciler. That is a choice about our own renderer. Forwarded
// into the workspace it silently changes the user's tooling: measured on npm
// 11, `NODE_ENV=production npm config get omit` reports `dev`, so an install
// the agent runs would omit devDependencies — no test runner, no compiler —
// and report success.
test('a NODE_ENV we injected ourselves is not forwarded to sandboxed commands', () => {
  withEnv({ NODE_ENV: 'production', [MARKER]: '1' }, () => {
    assert.equal('NODE_ENV' in scrubbedEnv(), false,
      'our own renderer setting must not become the workspace\'s build mode');
  });
});

test('the marker only suppresses NODE_ENV, not the rest of the allowlist', () => {
  withEnv({ NODE_ENV: 'production', [MARKER]: '1', PATH: '/usr/bin', HOME: '/home/x' }, () => {
    const env = scrubbedEnv();
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.HOME, '/home/x');
  });
});

test('the marker itself never reaches a sandboxed command', () => {
  withEnv({ NODE_ENV: 'production', [MARKER]: '1' }, () => {
    assert.equal(MARKER in scrubbedEnv(), false, 'internal plumbing is not the workspace\'s business');
  });
});

test('explicit extras still win over the allowlist', () => {
  withEnv({ NODE_ENV: 'production', [MARKER]: '1' }, () => {
    assert.equal(scrubbedEnv({ NODE_ENV: 'test' }).NODE_ENV, 'test',
      'a caller asking for a specific NODE_ENV is not the leak this guards against');
  });
});
