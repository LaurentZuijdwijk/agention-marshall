import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateToken, tokensMatch } from './token.js';

test('generateToken produces a non-trivial, url-safe token', () => {
  const token = generateToken();
  assert.ok(token.length >= 24);
  assert.doesNotMatch(token, /[+/=]/);
});

test('two generated tokens are not the same', () => {
  assert.notEqual(generateToken(), generateToken());
});

test('tokensMatch accepts the right token', () => {
  const token = generateToken();
  assert.equal(tokensMatch(token, token), true);
});

test('tokensMatch rejects a wrong token', () => {
  assert.equal(tokensMatch(generateToken(), 'wrong'), false);
});

test('tokensMatch rejects a missing token', () => {
  assert.equal(tokensMatch(generateToken(), undefined), false);
  assert.equal(tokensMatch(generateToken(), null), false);
  assert.equal(tokensMatch(generateToken(), ''), false);
});
