const test = require('node:test');
const assert = require('node:assert/strict');
const { isEmail, isPositiveInt, clamp } = require('./validator');

test('isEmail requires an @ and a domain', () => {
  assert.strictEqual(isEmail('a@b.com'), true);
  assert.strictEqual(isEmail('not-an-email'), false);
  assert.strictEqual(isEmail('missing-at.com'), false);
});

test('isPositiveInt requires positive integers only', () => {
  assert.strictEqual(isPositiveInt(5), true);
  assert.strictEqual(isPositiveInt(0), false);
  assert.strictEqual(isPositiveInt(-3), false);
  assert.strictEqual(isPositiveInt(1.5), false);
});

test('clamp keeps n within [min, max]', () => {
  assert.strictEqual(clamp(5, 0, 10), 5);
  assert.strictEqual(clamp(-5, 0, 10), 0);
  assert.strictEqual(clamp(50, 0, 10), 10);
});
