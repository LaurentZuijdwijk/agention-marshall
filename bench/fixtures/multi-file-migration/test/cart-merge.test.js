import test from 'node:test';
import assert from 'node:assert/strict';
import { onLog } from '../src/logger.js';
import { step0, step1, step2, step3 } from '../src/cart-merge.js';

test('cart-merge step0 logs loaded', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step0(17, 243);
  off();
  assert.deepStrictEqual(seen, [{ level: 'info', fields: { count: 17, ms: 243 }, message: 'loaded' }]);
});

test('cart-merge step1 logs batch flushed', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step1(64);
  off();
  assert.deepStrictEqual(seen, [{ level: 'debug', fields: { size: 64 }, message: 'batch flushed size=' }]);
});

test('cart-merge step2 logs loaded', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step2(17, 243);
  off();
  assert.deepStrictEqual(seen, [{ level: 'info', fields: { count: 17, ms: 243 }, message: 'loaded' }]);
});

test('cart-merge step3 logs rejected', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step3('req-91', 'quota');
  off();
  assert.deepStrictEqual(seen, [{ level: 'error', fields: { id: 'req-91', reason: 'quota' }, message: 'rejected' }]);
});
