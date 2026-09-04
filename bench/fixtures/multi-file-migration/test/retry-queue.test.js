import test from 'node:test';
import assert from 'node:assert/strict';
import { onLog } from '../src/logger.js';
import { step0, step1, step2, step3, step4 } from '../src/retry-queue.js';

test('retry-queue step0 logs batch flushed', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step0(64);
  off();
  assert.deepStrictEqual(seen, [{ level: 'debug', fields: { size: 64 }, message: 'batch flushed size=' }]);
});

test('retry-queue step1 logs started', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step1();
  off();
  assert.deepStrictEqual(seen, [{ level: 'info', fields: {  }, message: 'started' }]);
});

test('retry-queue step2 logs batch flushed', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step2(64);
  off();
  assert.deepStrictEqual(seen, [{ level: 'debug', fields: { size: 64 }, message: 'batch flushed size=' }]);
});

test('retry-queue step3 logs retry', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step3(2, 5, 'https://svc.internal/v1');
  off();
  assert.deepStrictEqual(seen, [{ level: 'warn', fields: { attempt: 2, max: 5, url: 'https://svc.internal/v1' }, message: 'retry' }]);
});

test('retry-queue step4 logs started', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step4();
  off();
  assert.deepStrictEqual(seen, [{ level: 'info', fields: {  }, message: 'started' }]);
});
