import test from 'node:test';
import assert from 'node:assert/strict';
import { onLog } from '../src/logger.js';
import { step0, step1, step2 } from '../src/batch-split.js';

test('batch-split step0 logs retry', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step0(2, 5, 'https://svc.internal/v1');
  off();
  assert.deepStrictEqual(seen, [{ level: 'warn', fields: { attempt: 2, max: 5, url: 'https://svc.internal/v1' }, message: 'retry' }]);
});

test('batch-split step1 logs slow response', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step1({ host: 'eu-2' }, 243);
  off();
  assert.deepStrictEqual(seen, [{ level: 'warn', fields: { host: 'eu-2', ms: 243 }, message: 'slow response from' }]);
});

test('batch-split step2 logs slow response', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step2({ host: 'eu-2' }, 243);
  off();
  assert.deepStrictEqual(seen, [{ level: 'warn', fields: { host: 'eu-2', ms: 243 }, message: 'slow response from' }]);
});
