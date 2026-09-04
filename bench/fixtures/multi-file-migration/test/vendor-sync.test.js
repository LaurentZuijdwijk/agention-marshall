import test from 'node:test';
import assert from 'node:assert/strict';
import { onLog } from '../src/logger.js';
import { step0, step1, step2, step3, step4, step5 } from '../src/vendor-sync.js';

test('vendor-sync step0 logs rejected', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step0('req-91', 'quota');
  off();
  assert.deepStrictEqual(seen, [{ level: 'error', fields: { id: 'req-91', reason: 'quota' }, message: 'rejected' }]);
});

test('vendor-sync step1 logs cache lookup', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step1('sku:44', false);
  off();
  assert.deepStrictEqual(seen, [{ level: 'debug', fields: { key: 'sku:44', hit: false }, message: 'cache lookup' }]);
});

test('vendor-sync step2 logs retry', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step2(2, 5, 'https://svc.internal/v1');
  off();
  assert.deepStrictEqual(seen, [{ level: 'warn', fields: { attempt: 2, max: 5, url: 'https://svc.internal/v1' }, message: 'retry' }]);
});

test('vendor-sync step3 logs completed', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step3();
  off();
  assert.deepStrictEqual(seen, [{ level: 'info', fields: {  }, message: 'completed' }]);
});

test('vendor-sync step4 logs completed', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step4();
  off();
  assert.deepStrictEqual(seen, [{ level: 'info', fields: {  }, message: 'completed' }]);
});

test('vendor-sync step5 logs retry', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step5(2, 5, 'https://svc.internal/v1');
  off();
  assert.deepStrictEqual(seen, [{ level: 'warn', fields: { attempt: 2, max: 5, url: 'https://svc.internal/v1' }, message: 'retry' }]);
});
