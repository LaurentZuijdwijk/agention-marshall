import test from 'node:test';
import assert from 'node:assert/strict';
import { onLog } from '../src/logger.js';
import { step0, step1, step2, step3 } from '../src/payment-capture.js';

test('payment-capture step0 logs slow response', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step0({ host: 'eu-2' }, 243);
  off();
  assert.deepStrictEqual(seen, [{ level: 'warn', fields: { host: 'eu-2', ms: 243 }, message: 'slow response from' }]);
});

test('payment-capture step1 logs loaded', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step1(17, 243);
  off();
  assert.deepStrictEqual(seen, [{ level: 'info', fields: { count: 17, ms: 243 }, message: 'loaded' }]);
});

test('payment-capture step2 logs slow response', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step2({ host: 'eu-2' }, 243);
  off();
  assert.deepStrictEqual(seen, [{ level: 'warn', fields: { host: 'eu-2', ms: 243 }, message: 'slow response from' }]);
});

test('payment-capture step3 logs loaded', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step3(17, 243);
  off();
  assert.deepStrictEqual(seen, [{ level: 'info', fields: { count: 17, ms: 243 }, message: 'loaded' }]);
});
