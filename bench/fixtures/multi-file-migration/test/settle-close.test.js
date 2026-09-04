import test from 'node:test';
import assert from 'node:assert/strict';
import { onLog } from '../src/logger.js';
import { step0, step1, step2, step3 } from '../src/settle-close.js';

test('settle-close step0 logs unreachable', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step0({ addr: '10.0.0.4' });
  off();
  assert.deepStrictEqual(seen, [{ level: 'error', fields: { addr: '10.0.0.4' }, message: 'unreachable' }]);
});

test('settle-close step1 logs unreachable', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step1({ addr: '10.0.0.4' });
  off();
  assert.deepStrictEqual(seen, [{ level: 'error', fields: { addr: '10.0.0.4' }, message: 'unreachable' }]);
});

test('settle-close step2 logs retry', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step2(2, 5, 'https://svc.internal/v1');
  off();
  assert.deepStrictEqual(seen, [{ level: 'warn', fields: { attempt: 2, max: 5, url: 'https://svc.internal/v1' }, message: 'retry' }]);
});

test('settle-close step3 logs rejected', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step3('req-91', 'quota');
  off();
  assert.deepStrictEqual(seen, [{ level: 'error', fields: { id: 'req-91', reason: 'quota' }, message: 'rejected' }]);
});
