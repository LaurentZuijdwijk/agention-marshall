import test from 'node:test';
import assert from 'node:assert/strict';
import { onLog } from '../src/logger.js';
import { step0, step1, step2, step3, step4 } from '../src/feed-import.js';

test('feed-import step0 logs retry', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step0(2, 5, 'https://svc.internal/v1');
  off();
  assert.deepStrictEqual(seen, [{ level: 'warn', fields: { attempt: 2, max: 5, url: 'https://svc.internal/v1' }, message: 'retry' }]);
});

test('feed-import step1 logs rejected', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step1('req-91', 'quota');
  off();
  assert.deepStrictEqual(seen, [{ level: 'error', fields: { id: 'req-91', reason: 'quota' }, message: 'rejected' }]);
});

test('feed-import step2 logs slow response', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step2({ host: 'eu-2' }, 243);
  off();
  assert.deepStrictEqual(seen, [{ level: 'warn', fields: { host: 'eu-2', ms: 243 }, message: 'slow response from' }]);
});

test('feed-import step3 logs loaded', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step3(17, 243);
  off();
  assert.deepStrictEqual(seen, [{ level: 'info', fields: { count: 17, ms: 243 }, message: 'loaded' }]);
});

test('feed-import step4 logs slow response', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step4({ host: 'eu-2' }, 243);
  off();
  assert.deepStrictEqual(seen, [{ level: 'warn', fields: { host: 'eu-2', ms: 243 }, message: 'slow response from' }]);
});
