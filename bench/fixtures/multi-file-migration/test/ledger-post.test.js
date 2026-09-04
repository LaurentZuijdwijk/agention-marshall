import test from 'node:test';
import assert from 'node:assert/strict';
import { onLog } from '../src/logger.js';
import { step0, step1, step2, step3 } from '../src/ledger-post.js';

test('ledger-post step0 logs retry', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step0(2, 5, 'https://svc.internal/v1');
  off();
  assert.deepStrictEqual(seen, [{ level: 'warn', fields: { attempt: 2, max: 5, url: 'https://svc.internal/v1' }, message: 'retry' }]);
});

test('ledger-post step1 logs completed', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step1();
  off();
  assert.deepStrictEqual(seen, [{ level: 'info', fields: {  }, message: 'completed' }]);
});

test('ledger-post step2 logs sync failed', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step2({ name: 'nightly' }, 1180);
  off();
  assert.deepStrictEqual(seen, [{ level: 'error', fields: { name: 'nightly', elapsed: 1180 }, message: 'sync failed for' }]);
});

test('ledger-post step3 logs cache lookup', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step3('sku:44', false);
  off();
  assert.deepStrictEqual(seen, [{ level: 'debug', fields: { key: 'sku:44', hit: false }, message: 'cache lookup' }]);
});
