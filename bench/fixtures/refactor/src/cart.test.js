const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateTotal } = require('./math');
const { formatReceipt } = require('./cart');

test('calculateTotal sums price * qty', () => {
  assert.strictEqual(calculateTotal([{ price: 2, qty: 3 }, { price: 5, qty: 1 }]), 11);
});

test('formatReceipt uses calculateTotal internally', () => {
  assert.strictEqual(formatReceipt([{ price: 10, qty: 2 }]), 'Total: $20.00');
});
