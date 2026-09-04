import test from 'node:test';
import assert from 'node:assert/strict';
import { onLog } from '../src/logger.js';
import { step0, step1, step2, step3, step4, step5 } from '../src/label-print.js';

test('label-print step0 logs sync failed', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step0({ name: 'nightly' }, 1180);
  off();
  assert.deepStrictEqual(seen, [{ level: 'error', fields: { name: 'nightly', elapsed: 1180 }, message: 'sync failed for' }]);
});

test('label-print step1 logs sync failed', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step1({ name: 'nightly' }, 1180);
  off();
  assert.deepStrictEqual(seen, [{ level: 'error', fields: { name: 'nightly', elapsed: 1180 }, message: 'sync failed for' }]);
});

test('label-print step2 logs loaded', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step2(17, 243);
  off();
  assert.deepStrictEqual(seen, [{ level: 'info', fields: { count: 17, ms: 243 }, message: 'loaded' }]);
});

test('label-print step3 logs started', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step3();
  off();
  assert.deepStrictEqual(seen, [{ level: 'info', fields: {  }, message: 'started' }]);
});

test('label-print step4 logs slow response', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step4({ host: 'eu-2' }, 243);
  off();
  assert.deepStrictEqual(seen, [{ level: 'warn', fields: { host: 'eu-2', ms: 243 }, message: 'slow response from' }]);
});

test('label-print step5 logs unreachable', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step5({ addr: '10.0.0.4' });
  off();
  assert.deepStrictEqual(seen, [{ level: 'error', fields: { addr: '10.0.0.4' }, message: 'unreachable' }]);
});
