import test from 'node:test';
import assert from 'node:assert/strict';
import { onLog } from '../src/logger.js';
import { step0, step1, step2 } from '../src/sku-normalize.js';

test('sku-normalize step0 logs slow response', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step0({ host: 'eu-2' }, 243);
  off();
  assert.deepStrictEqual(seen, [{ level: 'warn', fields: { host: 'eu-2', ms: 243 }, message: 'slow response from' }]);
});

test('sku-normalize step1 logs sync failed', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step1({ name: 'nightly' }, 1180);
  off();
  assert.deepStrictEqual(seen, [{ level: 'error', fields: { name: 'nightly', elapsed: 1180 }, message: 'sync failed for' }]);
});

test('sku-normalize step2 logs rejected', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step2('req-91', 'quota');
  off();
  assert.deepStrictEqual(seen, [{ level: 'error', fields: { id: 'req-91', reason: 'quota' }, message: 'rejected' }]);
});
