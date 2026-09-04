import test from 'node:test';
import assert from 'node:assert/strict';
import { onLog } from '../src/logger.js';
import { step0, step1, step2, step3, step4 } from '../src/order-sync.js';

test('order-sync step0 logs unreachable', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step0({ addr: '10.0.0.4' });
  off();
  assert.deepStrictEqual(seen, [{ level: 'error', fields: { addr: '10.0.0.4' }, message: 'unreachable' }]);
});

test('order-sync step1 logs slow response', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step1({ host: 'eu-2' }, 243);
  off();
  assert.deepStrictEqual(seen, [{ level: 'warn', fields: { host: 'eu-2', ms: 243 }, message: 'slow response from' }]);
});

test('order-sync step2 logs retry', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step2(2, 5, 'https://svc.internal/v1');
  off();
  assert.deepStrictEqual(seen, [{ level: 'warn', fields: { attempt: 2, max: 5, url: 'https://svc.internal/v1' }, message: 'retry' }]);
});

test('order-sync step3 logs cache lookup', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step3('sku:44', false);
  off();
  assert.deepStrictEqual(seen, [{ level: 'debug', fields: { key: 'sku:44', hit: false }, message: 'cache lookup' }]);
});

test('order-sync step4 logs loaded', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step4(17, 243);
  off();
  assert.deepStrictEqual(seen, [{ level: 'info', fields: { count: 17, ms: 243 }, message: 'loaded' }]);
});
