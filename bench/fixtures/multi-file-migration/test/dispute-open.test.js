import test from 'node:test';
import assert from 'node:assert/strict';
import { onLog } from '../src/logger.js';
import { step0, step1, step2, step3, step4 } from '../src/dispute-open.js';

test('dispute-open step0 logs started', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step0();
  off();
  assert.deepStrictEqual(seen, [{ level: 'info', fields: {  }, message: 'started' }]);
});

test('dispute-open step1 logs loaded', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step1(17, 243);
  off();
  assert.deepStrictEqual(seen, [{ level: 'info', fields: { count: 17, ms: 243 }, message: 'loaded' }]);
});

test('dispute-open step2 logs rejected', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step2('req-91', 'quota');
  off();
  assert.deepStrictEqual(seen, [{ level: 'error', fields: { id: 'req-91', reason: 'quota' }, message: 'rejected' }]);
});

test('dispute-open step3 logs loaded', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step3(17, 243);
  off();
  assert.deepStrictEqual(seen, [{ level: 'info', fields: { count: 17, ms: 243 }, message: 'loaded' }]);
});

test('dispute-open step4 logs batch flushed', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step4(64);
  off();
  assert.deepStrictEqual(seen, [{ level: 'debug', fields: { size: 64 }, message: 'batch flushed size=' }]);
});
