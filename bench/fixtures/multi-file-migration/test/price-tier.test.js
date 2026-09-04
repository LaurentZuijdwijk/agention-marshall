import test from 'node:test';
import assert from 'node:assert/strict';
import { onLog } from '../src/logger.js';
import { step0, step1, step2 } from '../src/price-tier.js';

test('price-tier step0 logs completed', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step0();
  off();
  assert.deepStrictEqual(seen, [{ level: 'info', fields: {  }, message: 'completed' }]);
});

test('price-tier step1 logs completed', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step1();
  off();
  assert.deepStrictEqual(seen, [{ level: 'info', fields: {  }, message: 'completed' }]);
});

test('price-tier step2 logs cache lookup', () => {
  const seen = [];
  const off = onLog(rec => seen.push(rec));
  step2('sku:44', false);
  off();
  assert.deepStrictEqual(seen, [{ level: 'debug', fields: { key: 'sku:44', hit: false }, message: 'cache lookup' }]);
});
