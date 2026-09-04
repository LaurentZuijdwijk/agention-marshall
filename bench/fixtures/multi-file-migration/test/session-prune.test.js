import test from 'node:test';
import assert from 'node:assert/strict';
import { onLog } from '../src/logger.js';
import { step0, step1, step2, step3, step4 } from '../src/session-prune.js';

test('session-prune step0 logs started', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step0();
  off();
  assert.deepStrictEqual(seen, [{ level: 'info', fields: {  }, message: 'started' }]);
});

test('session-prune step1 logs started', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step1();
  off();
  assert.deepStrictEqual(seen, [{ level: 'info', fields: {  }, message: 'started' }]);
});

test('session-prune step2 logs cache lookup', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step2('sku:44', false);
  off();
  assert.deepStrictEqual(seen, [{ level: 'debug', fields: { key: 'sku:44', hit: false }, message: 'cache lookup' }]);
});

test('session-prune step3 logs started', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step3();
  off();
  assert.deepStrictEqual(seen, [{ level: 'info', fields: {  }, message: 'started' }]);
});

test('session-prune step4 logs retry', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step4(2, 5, 'https://svc.internal/v1');
  off();
  assert.deepStrictEqual(seen, [{ level: 'warn', fields: { attempt: 2, max: 5, url: 'https://svc.internal/v1' }, message: 'retry' }]);
});
