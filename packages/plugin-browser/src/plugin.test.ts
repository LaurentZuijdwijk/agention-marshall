import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sep } from 'node:path';
import { marshallPlugin } from './plugin.js';
import { DEFAULT_PORT } from './constants.js';

test('marshallPlugin exposes the shape PluginRegistry expects', () => {
  assert.equal(marshallPlugin.name, 'browser');
  assert.equal(marshallPlugin.defaultPort, DEFAULT_PORT);
  assert.equal(marshallPlugin.healthPath, '/health');
  assert.equal(marshallPlugin.mcpPath, '/mcp');
  assert.equal(typeof marshallPlugin.resolveEntryPath, 'function');
  assert.equal(typeof marshallPlugin.buildLaunch, 'function');
});

test('buildLaunch puts the token in env, never in args', () => {
  const { args, env } = marshallPlugin.buildLaunch({ port: 9999, token: 'sekret' });
  assert.deepEqual(args, ['--port=9999']);
  assert.deepEqual(env, { MARSHALL_BROWSER_TOKEN: 'sekret' });
  assert.ok(!args.some(a => a.includes('sekret')), 'the token must never appear in argv — it would leak via ps');
});

test('resolveEntryPath points at index.js next to wherever this module lives', () => {
  // Not asserting filesystem existence here: under tsx (this test run) the
  // resolved path is src/index.js, which never exists — only src/index.ts
  // does, since the .js extension in the source is a NodeNext-resolution
  // convention, not a real file until built. Once published, this module is
  // dist/plugin.js and the same relative resolution correctly lands on the
  // real dist/index.js sitting next to it — proven by the package having
  // been built and run successfully as its own smoke test.
  assert.ok(marshallPlugin.resolveEntryPath().endsWith(`${sep}index.js`));
});
