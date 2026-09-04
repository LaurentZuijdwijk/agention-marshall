import test from 'node:test';
import assert from 'node:assert/strict';
import { onLog } from '../src/logger.js';
import { step0, step1, step2, step3 } from '../src/refund-issue.js';

test('refund-issue step0 logs retry', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step0(2, 5, 'https://svc.internal/v1');
  off();
  assert.deepStrictEqual(seen, [{ level: 'warn', fields: { attempt: 2, max: 5, url: 'https://svc.internal/v1' }, message: 'retry' }]);
});

test('refund-issue step1 logs slow response', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step1({ host: 'eu-2' }, 243);
  off();
  assert.deepStrictEqual(seen, [{ level: 'warn', fields: { host: 'eu-2', ms: 243 }, message: 'slow response from' }]);
});

test('refund-issue step2 logs slow response', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step2({ host: 'eu-2' }, 243);
  off();
  assert.deepStrictEqual(seen, [{ level: 'warn', fields: { host: 'eu-2', ms: 243 }, message: 'slow response from' }]);
});

test('refund-issue step3 logs completed', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step3();
  off();
  assert.deepStrictEqual(seen, [{ level: 'info', fields: {  }, message: 'completed' }]);
});
