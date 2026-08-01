const test = require('node:test');
const assert = require('node:assert/strict');
const { sum } = require('./sum');

test('sum of empty array is 0', () => {
  assert.strictEqual(sum([]), 0);
});

test('sum of positive numbers', () => {
  assert.strictEqual(sum([1, 2, 3]), 6);
});

test('sum of negative numbers', () => {
  assert.strictEqual(sum([-1, -2, -3]), -6);
});
