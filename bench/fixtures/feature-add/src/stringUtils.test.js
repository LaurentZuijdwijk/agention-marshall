const test = require('node:test');
const assert = require('node:assert/strict');
const { titleCase } = require('./stringUtils');

test('capitalizes each word', () => {
  assert.strictEqual(titleCase('hello world'), 'Hello World');
});

test('lowercases the remainder of each word', () => {
  assert.strictEqual(titleCase('HELLO WORLD'), 'Hello World');
});

test('handles a single word', () => {
  assert.strictEqual(titleCase('test'), 'Test');
});
