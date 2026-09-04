import test from 'node:test';
import assert from 'node:assert/strict';
import { onLog } from '../src/logger.js';
import { step0, step1, step2 } from '../src/digest-mail.js';

test('digest-mail step0 logs rejected', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step0('req-91', 'quota');
  off();
  assert.deepStrictEqual(seen, [{ level: 'error', fields: { id: 'req-91', reason: 'quota' }, message: 'rejected' }]);
});

test('digest-mail step1 logs sync failed', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step1({ name: 'nightly' }, 1180);
  off();
  assert.deepStrictEqual(seen, [{ level: 'error', fields: { name: 'nightly', elapsed: 1180 }, message: 'sync failed for' }]);
});

test('digest-mail step2 logs loaded', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step2(17, 243);
  off();
  assert.deepStrictEqual(seen, [{ level: 'info', fields: { count: 17, ms: 243 }, message: 'loaded' }]);
});
