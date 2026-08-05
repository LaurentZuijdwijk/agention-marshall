import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeAgentError, isConnectionError, isContextLengthError, endpointFor } from './errors.js';
import type { AgentProfile } from './config.js';

const LOCAL: AgentProfile = { provider: 'llamacpp', model: 'Qwen3.6-35B', host: 'http://192.168.1.248:8080' };
const ROUTER: AgentProfile = { provider: 'openrouter', model: 'deepseek/deepseek-v4', apiKey: 'k' };

test('a dead server names the host instead of saying "Connection error"', () => {
  const err = new Error('llama.cpp API error: Connection error.');
  const out = describeAgentError('summarizer', LOCAL, err);
  assert.match(out, /cannot reach http:\/\/192\.168\.1\.248:8080/);
  assert.match(out, /Is the server running/);
  assert.doesNotMatch(out, /Connection error\./);
});

test('OpenRouter failures are not labelled llama.cpp', () => {
  // LlamaCppAgent backs OpenRouter, so its errors self-describe as llama.cpp.
  const err = new Error('llama.cpp error: Response exceeded maximum token limit');
  const out = describeAgentError('review', ROUTER, err);
  assert.match(out, /openrouter\/deepseek\/deepseek-v4/);
  assert.match(out, /Response exceeded maximum token limit/);
  assert.doesNotMatch(out, /llama\.cpp/);
});

test('the role and model are always named', () => {
  const out = describeAgentError('coder', ROUTER, new Error('something odd'));
  assert.equal(out, 'coder · openrouter/deepseek/deepseek-v4 — something odd');
});

test('non-Error throwables still produce a message', () => {
  assert.match(describeAgentError('coder', ROUTER, 'plain string'), /plain string/);
});

test('connection failures are recognised across the shapes providers emit', () => {
  for (const m of [
    'Connection error.',
    'TypeError: fetch failed',
    'connect ECONNREFUSED 192.168.1.248:8080',
    'getaddrinfo ENOTFOUND api.example.com',
    'socket hang up',
    'ETIMEDOUT',
  ]) {
    assert.equal(isConnectionError(m), true, m);
  }
});

test('a refusal from a reachable server is not treated as unreachable', () => {
  assert.equal(isConnectionError('401 Unauthorized'), false);
  assert.equal(isConnectionError('Response exceeded maximum token limit'), false);
});

test('context-length failures are classified and actionable', () => {
  assert.equal(isContextLengthError('prompt is too long for the model context'), true);
  const out = describeAgentError('coder', LOCAL, new Error('llama.cpp API error: Provider returned error'));
  assert.match(out, /Provider returned error/);

  const detailed = Object.assign(new Error('llama.cpp API error: Provider returned error'), {
    statusCode: 400,
    response: { error: { message: 'context length exceeded' } },
  });
  const detailedOut = describeAgentError('coder', LOCAL, detailed);
  assert.match(detailedOut, /context length exceeded/);
  assert.match(detailedOut, /context length exceeded.*Reduce the prompt\/history or lower max tokens/);
});

test('provider response details are included when the wrapper message is generic', () => {
  const err = Object.assign(new Error('llama.cpp API error: Provider returned error'), {
    statusCode: 400,
    response: { error: { message: 'n_ctx is too small' } },
  });
  const out = describeAgentError('coder', LOCAL, err);
  assert.match(out, /400/);
  assert.match(out, /n_ctx is too small/);
});

test('endpointFor falls back to the provider default host', () => {
  assert.equal(endpointFor(LOCAL), 'http://192.168.1.248:8080');
  assert.equal(endpointFor({ provider: 'openrouter' }), 'https://openrouter.ai/api/v1');
  assert.equal(endpointFor({ provider: 'claude' }), 'claude');
});
