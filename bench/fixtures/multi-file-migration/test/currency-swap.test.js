import test from 'node:test';
import assert from 'node:assert/strict';
import { onLog } from '../src/logger.js';
import { step0, step1, step2 } from '../src/currency-swap.js';

test('currency-swap step0 logs started', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step0();
  off();
  assert.deepStrictEqual(seen, [{ level: 'info', fields: {  }, message: 'started' }]);
});

test('currency-swap step1 logs batch flushed', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step1(64);
  off();
  assert.deepStrictEqual(seen, [{ level: 'debug', fields: { size: 64 }, message: 'batch flushed size=' }]);
});

test('currency-swap step2 logs sync failed', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step2({ name: 'nightly' }, 1180);
  off();
  assert.deepStrictEqual(seen, [{ level: 'error', fields: { name: 'nightly', elapsed: 1180 }, message: 'sync failed for' }]);
});
