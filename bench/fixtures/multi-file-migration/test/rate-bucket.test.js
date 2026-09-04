import test from 'node:test';
import assert from 'node:assert/strict';
import { onLog } from '../src/logger.js';
import { step0, step1, step2, step3, step4, step5 } from '../src/rate-bucket.js';

test('rate-bucket step0 logs cache lookup', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step0('sku:44', false);
  off();
  assert.deepStrictEqual(seen, [{ level: 'debug', fields: { key: 'sku:44', hit: false }, message: 'cache lookup' }]);
});

test('rate-bucket step1 logs cache lookup', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step1('sku:44', false);
  off();
  assert.deepStrictEqual(seen, [{ level: 'debug', fields: { key: 'sku:44', hit: false }, message: 'cache lookup' }]);
});

test('rate-bucket step2 logs retry', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step2(2, 5, 'https://svc.internal/v1');
  off();
  assert.deepStrictEqual(seen, [{ level: 'warn', fields: { attempt: 2, max: 5, url: 'https://svc.internal/v1' }, message: 'retry' }]);
});

test('rate-bucket step3 logs completed', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step3();
  off();
  assert.deepStrictEqual(seen, [{ level: 'info', fields: {  }, message: 'completed' }]);
});

test('rate-bucket step4 logs sync failed', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step4({ name: 'nightly' }, 1180);
  off();
  assert.deepStrictEqual(seen, [{ level: 'error', fields: { name: 'nightly', elapsed: 1180 }, message: 'sync failed for' }]);
});

test('rate-bucket step5 logs cache lookup', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step5('sku:44', false);
  off();
  assert.deepStrictEqual(seen, [{ level: 'debug', fields: { key: 'sku:44', hit: false }, message: 'cache lookup' }]);
});
