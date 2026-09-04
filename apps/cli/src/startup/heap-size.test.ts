import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRespawn } from './heap-size.js';

const BARE_ENV = {} as NodeJS.ProcessEnv;

test('a fresh launch needs a respawn, for both the heap cap and NODE_ENV', () => {
  const plan = planRespawn(BARE_ENV, []);
  assert.equal(plan.needed, true);
  assert.match(plan.heapFlag!, /^--max-old-space-size=8192$/);
  assert.equal(plan.env.NODE_ENV, 'production');
  assert.equal(plan.env.MARSHALL_OLD_SPACE_RELOADED, '1');
});

test('the reload marker alone stops a second respawn once NODE_ENV is already set', () => {
  // What the child of the first respawn actually sees: the marker, and the
  // NODE_ENV the parent just filled in.
  const plan = planRespawn({ MARSHALL_OLD_SPACE_RELOADED: '1', NODE_ENV: 'production' } as NodeJS.ProcessEnv, []);
  assert.equal(plan.needed, false);
});

test('an existing --max-old-space-size exec flag counts as already raised', () => {
  const plan = planRespawn({ NODE_ENV: 'production' } as NodeJS.ProcessEnv, ['--max-old-space-size=4096']);
  assert.equal(plan.needed, false);
});

test('NODE_OPTIONS carrying the heap flag counts too', () => {
  const plan = planRespawn({ NODE_OPTIONS: '--max-old-space-size=4096', NODE_ENV: 'production' } as NodeJS.ProcessEnv, []);
  assert.equal(plan.needed, false);
});

test('heap already raised but NODE_ENV unset still respawns, for NODE_ENV alone', () => {
  const plan = planRespawn({ MARSHALL_OLD_SPACE_RELOADED: '1' } as NodeJS.ProcessEnv, []);
  assert.equal(plan.needed, true);
  // No heap flag needed this time — only NODE_ENV was missing.
  assert.equal(plan.heapFlag, undefined);
  assert.equal(plan.env.NODE_ENV, 'production');
});

// The fix must not silently override an explicit choice — a marshall
// developer debugging the TUI who sets NODE_ENV=development on purpose keeps
// react-reconciler's dev build and its extra warnings.
test('an explicit non-production NODE_ENV is preserved, not overwritten', () => {
  const plan = planRespawn({ NODE_ENV: 'development' } as NodeJS.ProcessEnv, []);
  // Heap still needs raising, so a respawn still happens...
  assert.equal(plan.needed, true);
  // ...but NODE_ENV travels through unchanged.
  assert.equal(plan.env.NODE_ENV, 'development');
});

test('MARSHALL_MAX_OLD_SPACE overrides the default heap size', () => {
  const plan = planRespawn({ MARSHALL_MAX_OLD_SPACE: '2048', NODE_ENV: 'production' } as NodeJS.ProcessEnv, []);
  assert.match(plan.heapFlag!, /^--max-old-space-size=2048$/);
});

test('a garbage MARSHALL_MAX_OLD_SPACE falls back to the default rather than producing a broken flag', () => {
  const plan = planRespawn({ MARSHALL_MAX_OLD_SPACE: 'not-a-number', NODE_ENV: 'production' } as NodeJS.ProcessEnv, []);
  assert.match(plan.heapFlag!, /^--max-old-space-size=8192$/);
});
