import test from 'node:test';
import assert from 'node:assert/strict';
import { onLog } from '../src/logger.js';
import { step0, step1, step2, step3 } from '../src/region-route.js';

test('region-route step0 logs batch flushed', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step0(64);
  off();
  assert.deepStrictEqual(seen, [{ level: 'debug', fields: { size: 64 }, message: 'batch flushed size=' }]);
});

test('region-route step1 logs slow response', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step1({ host: 'eu-2' }, 243);
  off();
  assert.deepStrictEqual(seen, [{ level: 'warn', fields: { host: 'eu-2', ms: 243 }, message: 'slow response from' }]);
});

test('region-route step2 logs sync failed', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step2({ name: 'nightly' }, 1180);
  off();
  assert.deepStrictEqual(seen, [{ level: 'error', fields: { name: 'nightly', elapsed: 1180 }, message: 'sync failed for' }]);
});

test('region-route step3 logs loaded', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step3(17, 243);
  off();
  assert.deepStrictEqual(seen, [{ level: 'info', fields: { count: 17, ms: 243 }, message: 'loaded' }]);
});
