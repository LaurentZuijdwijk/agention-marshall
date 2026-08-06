// ── CLI integration: keystrokes in, rendered transcript out ───────────────────
//
// The real App, the real engine Session, the real tool belt — only the model
// server is faked. App.test.ts substitutes a MockSession, so it can never catch
// a break in the wiring *between* the two: an event the engine emits and the
// client doesn't translate, an approval that never reaches the panel, a tool
// result that never lands in the transcript. That gap is what these cover.

import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import React from 'react';
import { render } from 'ink';
import { startFakeProvider } from '@agentionai/marshall-engine/testing';
import type { ScriptedTurn } from '@agentionai/marshall-engine/testing';
import { App } from '../App.js';
import { fakeStdout, fakeStdin, waitFor, KEY } from '../testing/ink.js';

/**
 * Everything a driven session needs, torn down together.
 *
 * `t.after` rather than a global afterEach: an Ink instance left mounted on a
 * failed assertion keeps the runner waiting on its handles, which is how one
 * bad test turns into a two-minute suite.
 */
async function drive(t: TestContext, script: ScriptedTurn[], workspaceFiles: Record<string, string> = {}) {
  const workspace = mkdtempSync(join(tmpdir(), 'marshall-cli-integration-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  for (const [name, content] of Object.entries(workspaceFiles)) {
    writeFileSync(join(workspace, name), content);
  }

  const fake = await startFakeProvider(...script);
  t.after(() => fake.close());

  let output = '';
  const stdout = fakeStdout(chunk => { output += chunk; });
  const stdin = fakeStdin();

  const instance = render(
    React.createElement(App, {
      workspaceRoot: workspace,
      // The real Session is the default SessionCtor — that is the point here.
      agentProfile: { provider: 'llamacpp', host: fake.host, model: 'test-model' },
    }),
    { stdout, stdin, patchConsole: false, exitOnCtrlC: false },
  );
  t.after(() => instance.unmount());

  return {
    workspace,
    fake,
    stdin,
    /** Everything Ink has written so far. */
    screen: () => output,
    /** Wait for `text` to appear anywhere in the output. */
    until: (text: string, what = `"${text}"`) => waitFor(() => output.includes(text), what),
    /** Type and submit, once the prompt is accepting input. */
    async submit(task: string) {
      await waitFor(() => output.includes('type a task'), 'the idle prompt');
      stdin.push(task);
      await waitFor(() => output.includes(task), 'the typed task to echo');
      stdin.push(KEY.enter);
    },
  };
}

test('a task that edits a file: tool row, approval panel, answer', async (t) => {
  const app = await drive(t, [
    {
      text: 'I will create it.',
      toolCalls: [{ name: 'write_file', arguments: { path: 'notes.md', content: '# notes\n' } }],
    },
    { text: 'Created notes.md.' },
  ]);

  await app.submit('create notes.md');

  // The gated call surfaces as an approval the user can actually answer.
  await app.until('approval required', 'the approval panel');
  assert.match(app.screen(), /Write file/, 'the pending call is named in the panel');
  assert.equal(existsSync(join(app.workspace, 'notes.md')), false,
    'nothing is written while the approval is still on screen');

  app.stdin.push('y');

  await app.until('Created notes.md.', 'the final answer');
  assert.equal(readFileSync(join(app.workspace, 'notes.md'), 'utf8'), '# notes\n',
    'approving actually ran the tool');
  assert.match(app.screen(), /approved/, 'the decision is recorded in the transcript');
});

test('denying from the panel stops the write and the turn carries on', async (t) => {
  const app = await drive(t, [
    { toolCalls: [{ name: 'write_file', arguments: { path: 'nope.md', content: 'x' } }] },
    { text: 'Left it alone.' },
  ]);

  await app.submit('write nope.md');
  await app.until('approval required', 'the approval panel');

  app.stdin.push('n');

  await app.until('Left it alone.', 'the answer after the denial');
  assert.equal(existsSync(join(app.workspace, 'nope.md')), false, 'a denied write touches nothing');
  assert.match(app.screen(), /denied/, 'the denial is recorded in the transcript');
});

test('an ungated read renders as a tool row with no prompt', async (t) => {
  const app = await drive(
    t,
    [
      { toolCalls: [{ name: 'read_file', arguments: { path: 'readme.md' } }] },
      { text: 'It is a one-line readme.' },
    ],
    { 'readme.md': 'hello from the workspace\n' },
  );

  await app.submit('what is in readme.md?');
  await app.until('It is a one-line readme.', 'the answer');

  assert.match(app.screen(), /Read file/, 'the read is shown as a tool row');
  assert.doesNotMatch(app.screen(), /approval required/,
    'read_file is not gated, so nothing should have asked');
  // The tool result reached the model, not just the screen.
  const followUp = app.fake.requests[1];
  const toolResult = followUp.messages.find(m => m.role === 'tool');
  assert.match(String(toolResult?.content), /hello from the workspace/);
});

test('the engine error path renders as an error row, not a crash', async (t) => {
  const app = await drive(t, [
    { toolCalls: [{ name: 'no_such_tool', arguments: {} }] },
    { text: 'That tool does not exist; here is what I can do instead.' },
  ]);

  await app.submit('use a tool that is not there');
  await app.until('That tool does not exist', 'the recovered answer');

  // A missing tool comes back to the model as a result it can react to — the
  // turn must not die on it.
  const followUp = app.fake.requests[1];
  const toolResult = followUp.messages.find(m => m.role === 'tool');
  assert.match(String(toolResult?.content), /not found/i);
});
