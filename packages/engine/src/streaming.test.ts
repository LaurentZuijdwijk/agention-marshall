import { test } from 'node:test';
import assert from 'node:assert/strict';
import EventEmitter from 'node:events';
import { AgentEvent } from '@agentionai/agents/core';
import type { BaseAgent } from '@agentionai/agents/core';
import { runAgent } from './streaming.js';
import type { StreamChunk } from './streaming.js';

/**
 * A script for a fake agent: each entry is one assistant turn, and every turn
 * but the last ends by calling a tool. This mirrors what the real agents do —
 * chunks first, then `TOOL_USE`, then the next turn — which is the ordering the
 * final-answer accumulation depends on.
 */
type Turn = { chunks: StreamChunk[]; callsTool?: boolean };

function streamingAgent(turns: Turn[]): BaseAgent<string, string> {
  const agent = new EventEmitter() as EventEmitter & { executeStream: unknown };
  agent.executeStream = async function* () {
    for (const turn of turns) {
      yield* turn.chunks;
      if (turn.callsTool) agent.emit(AgentEvent.TOOL_USE, [{ type: 'tool_use', name: 'read_file', input: {} }]);
    }
  };
  return agent as unknown as BaseAgent<string, string>;
}

function nonStreamingAgent(answer: string): BaseAgent<string, string> {
  const agent = new EventEmitter() as EventEmitter & { execute: unknown };
  agent.execute = async (input: string) => `${answer}:${input}`;
  return agent as unknown as BaseAgent<string, string>;
}

const text = (content: string): StreamChunk => ({ type: 'text', content });

test('falls back to execute() on providers that cannot stream', async () => {
  const seen: StreamChunk[] = [];
  const answer = await runAgent(nonStreamingAgent('done'), 'the task', c => seen.push(c));

  assert.equal(answer, 'done:the task');
  assert.deepEqual(seen, [], 'nothing to stream when the provider only has execute()');
});

test('forwards every chunk in order, reasoning included', async () => {
  const agent = streamingAgent([
    { chunks: [{ type: 'reasoning', content: 'hmm' }, text('hel'), text('lo')] },
  ]);

  const seen: StreamChunk[] = [];
  await runAgent(agent, 'hi', c => seen.push(c));

  assert.deepEqual(seen.map(c => `${c.type}:${c.content}`), ['reasoning:hmm', 'text:hel', 'text:lo']);
});

test('returns the streamed text, joined', async () => {
  const agent = streamingAgent([{ chunks: [text('two '), text('halves')] }]);
  assert.equal(await runAgent(agent, 'hi', () => {}), 'two halves');
});

test('returns only the final turn — prose before a tool call is not repeated', async () => {
  // The client already committed "Reading the config first." above the tool row.
  // Returning it again as the answer would print it a second time.
  const agent = streamingAgent([
    { chunks: [text('Reading the config first.')], callsTool: true },
    { chunks: [text('It sets the port to 8080.')] },
  ]);

  assert.equal(await runAgent(agent, 'what port?', () => {}), 'It sets the port to 8080.');
});

test('reasoning never leaks into the answer', async () => {
  const agent = streamingAgent([
    { chunks: [{ type: 'reasoning', content: 'let me think' }, text('42')] },
  ]);

  assert.equal(await runAgent(agent, 'hi', () => {}), '42');
});

test('detaches its turn listener when the run ends', async () => {
  const agent = streamingAgent([{ chunks: [text('ok')], callsTool: true }, { chunks: [text('done')] }]);
  const emitter = agent as unknown as EventEmitter;

  await runAgent(agent, 'hi', () => {});
  assert.equal(emitter.listenerCount(AgentEvent.TOOL_USE), 0);
});

test('detaches its turn listener when the run throws', async () => {
  const agent = new EventEmitter() as EventEmitter & { executeStream: unknown };
  agent.executeStream = async function* (): AsyncGenerator<StreamChunk> {
    yield text('partial');
    throw new Error('server went away');
  };

  await assert.rejects(
    runAgent(agent as unknown as BaseAgent<string, string>, 'hi', () => {}),
    /server went away/,
  );
  assert.equal(agent.listenerCount(AgentEvent.TOOL_USE), 0);
});
