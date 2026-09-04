import test from 'node:test';
import assert from 'node:assert/strict';
import { onLog } from '../src/logger.js';
import { step0, step1, step2 } from '../src/audit-append.js';

test('audit-append step0 logs batch flushed', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step0(64);
  off();
  assert.deepStrictEqual(seen, [{ level: 'debug', fields: { size: 64 }, message: 'batch flushed size=' }]);
});

test('audit-append step1 logs unreachable', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step1({ addr: '10.0.0.4' });
  off();
  assert.deepStrictEqual(seen, [{ level: 'error', fields: { addr: '10.0.0.4' }, message: 'unreachable' }]);
});

test('audit-append step2 logs cache lookup', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step2('sku:44', false);
  off();
  assert.deepStrictEqual(seen, [{ level: 'debug', fields: { key: 'sku:44', hit: false }, message: 'cache lookup' }]);
});
