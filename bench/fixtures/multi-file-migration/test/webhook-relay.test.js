import test from 'node:test';
import assert from 'node:assert/strict';
import { onLog } from '../src/logger.js';
import { step0, step1, step2 } from '../src/webhook-relay.js';

test('webhook-relay step0 logs started', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step0();
  off();
  assert.deepStrictEqual(seen, [{ level: 'info', fields: {  }, message: 'started' }]);
});

test('webhook-relay step1 logs retry', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step1(2, 5, 'https://svc.internal/v1');
  off();
  assert.deepStrictEqual(seen, [{ level: 'warn', fields: { attempt: 2, max: 5, url: 'https://svc.internal/v1' }, message: 'retry' }]);
});

test('webhook-relay step2 logs started', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step2();
  off();
  assert.deepStrictEqual(seen, [{ level: 'info', fields: {  }, message: 'started' }]);
});
