import test from 'node:test';
import assert from 'node:assert/strict';
import { onLog } from '../src/logger.js';
import { step0, step1, step2 } from '../src/invoice-parse.js';

test('invoice-parse step0 logs unreachable', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step0({ addr: '10.0.0.4' });
  off();
  assert.deepStrictEqual(seen, [{ level: 'error', fields: { addr: '10.0.0.4' }, message: 'unreachable' }]);
});

test('invoice-parse step1 logs slow response', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step1({ host: 'eu-2' }, 243);
  off();
  assert.deepStrictEqual(seen, [{ level: 'warn', fields: { host: 'eu-2', ms: 243 }, message: 'slow response from' }]);
});

test('invoice-parse step2 logs batch flushed', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step2(64);
  off();
  assert.deepStrictEqual(seen, [{ level: 'debug', fields: { size: 64 }, message: 'batch flushed size=' }]);
});
