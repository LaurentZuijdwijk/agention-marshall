import test from 'node:test';
import assert from 'node:assert/strict';
import { onLog } from '../src/logger.js';
import { step0, step1, step2 } from '../src/catalog-index.js';

test('catalog-index step0 logs rejected', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step0('req-91', 'quota');
  off();
  assert.deepStrictEqual(seen, [{ level: 'error', fields: { id: 'req-91', reason: 'quota' }, message: 'rejected' }]);
});

test('catalog-index step1 logs unreachable', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step1({ addr: '10.0.0.4' });
  off();
  assert.deepStrictEqual(seen, [{ level: 'error', fields: { addr: '10.0.0.4' }, message: 'unreachable' }]);
});

test('catalog-index step2 logs loaded', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step2(17, 243);
  off();
  assert.deepStrictEqual(seen, [{ level: 'info', fields: { count: 17, ms: 243 }, message: 'loaded' }]);
});
