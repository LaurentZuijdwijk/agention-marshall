import test from 'node:test';
import assert from 'node:assert/strict';
import { onLog } from '../src/logger.js';
import { step0, step1, step2 } from '../src/fraud-score.js';

test('fraud-score step0 logs retry', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step0(2, 5, 'https://svc.internal/v1');
  off();
  assert.deepStrictEqual(seen, [{ level: 'warn', fields: { attempt: 2, max: 5, url: 'https://svc.internal/v1' }, message: 'retry' }]);
});

test('fraud-score step1 logs batch flushed', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step1(64);
  off();
  assert.deepStrictEqual(seen, [{ level: 'debug', fields: { size: 64 }, message: 'batch flushed size=' }]);
});

test('fraud-score step2 logs unreachable', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step2({ addr: '10.0.0.4' });
  off();
  assert.deepStrictEqual(seen, [{ level: 'error', fields: { addr: '10.0.0.4' }, message: 'unreachable' }]);
});
