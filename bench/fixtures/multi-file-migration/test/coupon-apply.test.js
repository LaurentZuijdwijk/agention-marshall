import test from 'node:test';
import assert from 'node:assert/strict';
import { onLog } from '../src/logger.js';
import { step0, step1, step2 } from '../src/coupon-apply.js';

test('coupon-apply step0 logs slow response', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step0({ host: 'eu-2' }, 243);
  off();
  assert.deepStrictEqual(seen, [{ level: 'warn', fields: { host: 'eu-2', ms: 243 }, message: 'slow response from' }]);
});

test('coupon-apply step1 logs unreachable', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step1({ addr: '10.0.0.4' });
  off();
  assert.deepStrictEqual(seen, [{ level: 'error', fields: { addr: '10.0.0.4' }, message: 'unreachable' }]);
});

test('coupon-apply step2 logs sync failed', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step2({ name: 'nightly' }, 1180);
  off();
  assert.deepStrictEqual(seen, [{ level: 'error', fields: { name: 'nightly', elapsed: 1180 }, message: 'sync failed for' }]);
});
