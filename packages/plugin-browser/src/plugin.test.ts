import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sep } from 'node:path';
import { marshallPlugin, extensionSetupInstructions } from './plugin.js';
import { DEFAULT_PORT } from './constants.js';

test('setup instructions link the guide, ZIP and bridge on the chosen port', () => {
  for (const port of [DEFAULT_PORT, 9999]) {
    const instructions = extensionSetupInstructions({ port });
    assert.ok(instructions.includes(`http://127.0.0.1:${port}/setup`));
    assert.ok(instructions.includes(`http://127.0.0.1:${port}/extension.zip`));
    assert.ok(instructions.includes(`ws://127.0.0.1:${port}/bridge`));
    assert.ok(instructions.includes('https://marshall.agention.ai/docs.html#browser-extension'));
    assert.match(instructions, /manifest\.json/);
    assert.match(instructions, /Save & connect/);
    assert.match(instructions, /No reinstall needed/);
  }
});

test('an already-paired extension is not told to paste a token it never saw', () => {
  assert.match(extensionSetupInstructions(), /paste the pairing token/);
  const paired = extensionSetupInstructions({ paired: true });
  assert.doesNotMatch(paired, /paste the pairing token/);
  assert.match(paired, /keeps its token/);
  assert.ok(paired.includes(`ws://127.0.0.1:${DEFAULT_PORT}/bridge`), 'the bridge URL still helps a manual re-pair');
});

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
