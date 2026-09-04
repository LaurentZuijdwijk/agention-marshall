import test from 'node:test';
import assert from 'node:assert/strict';
import { onLog } from '../src/logger.js';
import { step0, step1, step2, step3, step4 } from '../src/address-verify.js';

test('address-verify step0 logs cache lookup', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step0('sku:44', false);
  off();
  assert.deepStrictEqual(seen, [{ level: 'debug', fields: { key: 'sku:44', hit: false }, message: 'cache lookup' }]);
});

test('address-verify step1 logs sync failed', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step1({ name: 'nightly' }, 1180);
  off();
  assert.deepStrictEqual(seen, [{ level: 'error', fields: { name: 'nightly', elapsed: 1180 }, message: 'sync failed for' }]);
});

test('address-verify step2 logs retry', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step2(2, 5, 'https://svc.internal/v1');
  off();
  assert.deepStrictEqual(seen, [{ level: 'warn', fields: { attempt: 2, max: 5, url: 'https://svc.internal/v1' }, message: 'retry' }]);
});

test('address-verify step3 logs batch flushed', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step3(64);
  off();
  assert.deepStrictEqual(seen, [{ level: 'debug', fields: { size: 64 }, message: 'batch flushed size=' }]);
});

test('address-verify step4 logs unreachable', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step4({ addr: '10.0.0.4' });
  off();
  assert.deepStrictEqual(seen, [{ level: 'error', fields: { addr: '10.0.0.4' }, message: 'unreachable' }]);
});
