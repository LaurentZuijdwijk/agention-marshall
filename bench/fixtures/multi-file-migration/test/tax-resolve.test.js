import test from 'node:test';
import assert from 'node:assert/strict';
import { onLog } from '../src/logger.js';
import { step0, step1, step2, step3, step4 } from '../src/tax-resolve.js';

test('tax-resolve step0 logs started', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step0();
  off();
  assert.deepStrictEqual(seen, [{ level: 'info', fields: {  }, message: 'started' }]);
});

test('tax-resolve step1 logs started', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step1();
  off();
  assert.deepStrictEqual(seen, [{ level: 'info', fields: {  }, message: 'started' }]);
});

test('tax-resolve step2 logs slow response', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step2({ host: 'eu-2' }, 243);
  off();
  assert.deepStrictEqual(seen, [{ level: 'warn', fields: { host: 'eu-2', ms: 243 }, message: 'slow response from' }]);
});

test('tax-resolve step3 logs batch flushed', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step3(64);
  off();
  assert.deepStrictEqual(seen, [{ level: 'debug', fields: { size: 64 }, message: 'batch flushed size=' }]);
});

test('tax-resolve step4 logs slow response', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step4({ host: 'eu-2' }, 243);
  off();
  assert.deepStrictEqual(seen, [{ level: 'warn', fields: { host: 'eu-2', ms: 243 }, message: 'slow response from' }]);
});
