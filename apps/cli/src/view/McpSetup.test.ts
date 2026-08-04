import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { suggestName, validateUrl } from './McpSetup.js';

describe('suggestName', () => {
  it('takes the memorable part of the host', () => {
    assert.equal(suggestName('https://mcp.linear.app/mcp'), 'linear');
    assert.equal(suggestName('https://api.githubcopilot.com/mcp/'), 'githubcopilot');
  });

  it('handles a bare host with no suffix', () => {
    assert.equal(suggestName('http://localhost:3000/mcp'), 'localhost');
  });

  it('sanitises anything that would be invalid in a tool name', () => {
    assert.match(suggestName('https://my~server.example.com/mcp'), /^[a-zA-Z0-9_-]*$/);
  });

  it('gives up quietly on nonsense rather than throwing', () => {
    assert.equal(suggestName('not a url'), '');
  });
});

describe('validateUrl', () => {
  it('accepts https', () => {
    assert.equal(validateUrl('https://mcp.linear.app/mcp'), null);
  });

  it('accepts plain http to loopback, which cannot be sniffed', () => {
    assert.equal(validateUrl('http://localhost:3000/mcp'), null);
    assert.equal(validateUrl('http://127.0.0.1:3000/mcp'), null);
  });

  // The token is sent as an Authorization header on every call, so this is the
  // difference between a secret and a broadcast.
  it('refuses plain http to a remote host', () => {
    const problem = validateUrl('http://mcp.example.com/mcp');
    assert.ok(problem);
    assert.match(problem, /clear/);
  });

  it('refuses a scheme that is not http', () => {
    assert.match(validateUrl('ftp://example.com/mcp')!, /Only http and https/);
  });

  it('refuses something that is not a URL at all', () => {
    assert.match(validateUrl('mcp.example.com')!, /not a valid URL/);
  });
});
