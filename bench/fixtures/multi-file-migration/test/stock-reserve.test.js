import test from 'node:test';
import assert from 'node:assert/strict';
import { onLog } from '../src/logger.js';
import { step0, step1, step2, step3, step4 } from '../src/stock-reserve.js';

test('stock-reserve step0 logs batch flushed', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step0(64);
  off();
  assert.deepStrictEqual(seen, [{ level: 'debug', fields: { size: 64 }, message: 'batch flushed size=' }]);
});

test('stock-reserve step1 logs unreachable', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step1({ addr: '10.0.0.4' });
  off();
  assert.deepStrictEqual(seen, [{ level: 'error', fields: { addr: '10.0.0.4' }, message: 'unreachable' }]);
});

test('stock-reserve step2 logs completed', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step2();
  off();
  assert.deepStrictEqual(seen, [{ level: 'info', fields: {  }, message: 'completed' }]);
});

test('stock-reserve step3 logs batch flushed', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step3(64);
  off();
  assert.deepStrictEqual(seen, [{ level: 'debug', fields: { size: 64 }, message: 'batch flushed size=' }]);
});

test('stock-reserve step4 logs sync failed', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step4({ name: 'nightly' }, 1180);
  off();
  assert.deepStrictEqual(seen, [{ level: 'error', fields: { name: 'nightly', elapsed: 1180 }, message: 'sync failed for' }]);
});
