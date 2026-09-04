import test from 'node:test';
import assert from 'node:assert/strict';
import { onLog } from '../src/logger.js';
import { step0, step1, step2 } from '../src/quote-build.js';

test('quote-build step0 logs cache lookup', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step0('sku:44', false);
  off();
  assert.deepStrictEqual(seen, [{ level: 'debug', fields: { key: 'sku:44', hit: false }, message: 'cache lookup' }]);
});

test('quote-build step1 logs cache lookup', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step1('sku:44', false);
  off();
  assert.deepStrictEqual(seen, [{ level: 'debug', fields: { key: 'sku:44', hit: false }, message: 'cache lookup' }]);
});

test('quote-build step2 logs sync failed', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step2({ name: 'nightly' }, 1180);
  off();
  assert.deepStrictEqual(seen, [{ level: 'error', fields: { name: 'nightly', elapsed: 1180 }, message: 'sync failed for' }]);
});
