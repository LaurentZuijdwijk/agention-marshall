import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAskTool } from './ask-tool.js';
import type { AskFn, AskRequest } from '../types.js';

const execute = (tool: ReturnType<typeof createAskTool>, input: Record<string, unknown>) =>
  tool.execute('a', 'b', input, 'id');

test('forwards the question to the ask function', async () => {
  let received: AskRequest | null = null;
  const ask: AskFn = async (req) => { received = req; return 'go ahead'; };

  const result = await execute(createAskTool(ask), { question: 'Which direction?' });
  assert.equal(result, 'go ahead');
  assert.deepEqual(received, { question: 'Which direction?' });
});

test('passes through options', async () => {
  let received: AskRequest | null = null;
  const ask: AskFn = async (req) => { received = req; return 'left'; };

  await execute(createAskTool(ask), { question: 'Go where?', options: ['left', 'right'] });
  assert.deepEqual(received, { question: 'Go where?', options: ['left', 'right'] });
});

test('normalises string options and boolean flags', async () => {
  let received: AskRequest | null = null;
  const ask: AskFn = async (req) => { received = req; return 'yes'; };

  await execute(
    createAskTool(ask),
    { question: 'Continue?', options: [1, 2] as unknown as string[], multiSelect: true, allowFreeText: true },
  );
  assert.deepEqual(received, {
    question: 'Continue?', options: ['1', '2'], multiSelect: true, allowFreeText: true,
  });
});

test('omits absent optional fields so the panel renders by presence', async () => {
  let received: AskRequest | null = null;
  const ask: AskFn = async (req) => { received = req; return 'ok'; };

  await execute(createAskTool(ask), { question: 'Proceed?' });
  assert.deepEqual(received, { question: 'Proceed?' });
  assert.ok(!('options' in (received as Record<string, unknown>)));
  assert.ok(!('multiSelect' in (received as Record<string, unknown>)));
});

test('returns the model string cast as the tool result', async () => {
  // ask() returns a plain string; the tool surfaces it verbatim to the agent.
  const ask: AskFn = async () => 'pick the blue door';
  const result = await execute(createAskTool(ask), { question: 'Which door?' });
  assert.equal(result, 'pick the blue door');
});
