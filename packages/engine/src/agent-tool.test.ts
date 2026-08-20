import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentTool } from './agent-tool.js';
import type { Executable } from './agent-tool.js';

/** Invoke the tool the way a provider does. */
function call(tool: ReturnType<typeof agentTool>, instructions: string): Promise<string> {
  return tool.execute('agent-id', 'agent-name', { instructions }, 'block-id');
}

test('a fresh agent is spawned for every invocation', async () => {
  let spawned = 0;
  const tool = agentTool({
    name: 'probe',
    description: 'probe',
    spawn: async (): Promise<Executable> => {
      spawned++;
      return { execute: async (i) => i };
    },
  });

  await call(tool, 'one');
  await call(tool, 'two');

  assert.equal(spawned, 2);
});

test('concurrent calls stay isolated — each sees only its own instructions', async () => {
  // Each spawned agent records the instruction it was given. If the tool reused
  // one agent, the later call would overwrite the earlier one's state and the
  // results would cross. Staggered delays force the calls to overlap.
  const tool = agentTool({
    name: 'probe',
    description: 'probe',
    spawn: async (): Promise<Executable> => {
      let mine: string | undefined;
      return {
        execute: async (instructions) => {
          mine = instructions;
          await new Promise(r => setTimeout(r, 30 - instructions.length));
          return mine;   // must still be this call's own value
        },
      };
    },
  });

  const results = await Promise.all([
    call(tool, 'alpha'),
    call(tool, 'be'),
    call(tool, 'gamma!'),
  ]);

  assert.deepEqual(results, ['alpha', 'be', 'gamma!']);
});

test('parallel calls actually overlap rather than queueing', async () => {
  const tool = agentTool({
    name: 'probe',
    description: 'probe',
    spawn: async (): Promise<Executable> => ({
      execute: async (i) => { await new Promise(r => setTimeout(r, 60)); return i; },
    }),
  });

  const started = Date.now();
  await Promise.all([call(tool, 'a'), call(tool, 'b'), call(tool, 'c')]);
  const elapsed = Date.now() - started;

  // Serialised would be ~180ms; parallel is ~60ms. Generous bound for CI noise.
  assert.ok(elapsed < 150, `expected overlap, took ${elapsed}ms`);
});

test('a spawn failure is returned as a result, not thrown', async () => {
  const tool = agentTool({
    name: 'probe',
    description: 'probe',
    spawn: async () => { throw new Error('no api key'); },
  });

  const out = await call(tool, 'anything');
  assert.deepEqual(JSON.parse(out), { error: 'Failed to execute instructions: no api key' });
});

test('an execute failure is returned as a result, not thrown', async () => {
  const tool = agentTool({
    name: 'probe',
    description: 'probe',
    spawn: async (): Promise<Executable> => ({
      execute: async () => { throw new Error('model exploded'); },
    }),
  });

  const out = await call(tool, 'anything');
  assert.deepEqual(JSON.parse(out), { error: 'Failed to execute instructions: model exploded' });
});

test('one failing call does not affect its siblings', async () => {
  const tool = agentTool({
    name: 'probe',
    description: 'probe',
    spawn: async (): Promise<Executable> => ({
      execute: async (i) => {
        if (i === 'bad') throw new Error('boom');
        return i;
      },
    }),
  });

  const [ok1, bad, ok2] = await Promise.all([
    call(tool, 'good-1'),
    call(tool, 'bad'),
    call(tool, 'good-2'),
  ]);

  assert.equal(ok1, 'good-1');
  assert.equal(ok2, 'good-2');
  assert.match(bad, /boom/);
});

test('start and end hooks fire around each invocation', async () => {
  const events: string[] = [];
  const tool = agentTool({
    name: 'probe',
    description: 'probe',
    spawn: async (): Promise<Executable> => ({ execute: async (i) => `ok:${i}` }),
    onStart: ({ id, instructions }) => events.push(`start#${id}:${instructions}`),
    onEnd: ({ id, result }) => events.push(`end#${id}:${result}`),
  });

  await call(tool, 'one');
  await call(tool, 'two');

  assert.deepEqual(events, ['start#0:one', 'end#0:ok:one', 'start#1:two', 'end#1:ok:two']);
});

test('fan-out is visible in the log — all starts precede the first end', async () => {
  const events: string[] = [];
  const tool = agentTool({
    name: 'probe',
    description: 'probe',
    spawn: async (): Promise<Executable> => ({
      execute: async (i) => { await new Promise(r => setTimeout(r, 30)); return i; },
    }),
    onStart: ({ id }) => events.push(`start#${id}`),
    onEnd: ({ id }) => events.push(`end#${id}`),
  });

  await Promise.all([call(tool, 'a'), call(tool, 'b'), call(tool, 'c')]);

  assert.deepEqual(events.slice(0, 3), ['start#0', 'start#1', 'start#2']);
  assert.deepEqual(events.slice(3).sort(), ['end#0', 'end#1', 'end#2']);
});

// The usage tally prefers a provider-reported cost to a price-table lookup, and
// for a sub-agent on a model missing from the catalogue it is the only figure
// there is — so it has to survive the hop from the agent to onEnd rather than
// being narrowed away by the type in between.
test('a provider-reported cost reaches onEnd alongside the token counts', async () => {
  const ends: Array<number | undefined> = [];
  const tool = agentTool({
    name: 'probe',
    description: 'probe',
    spawn: async (): Promise<Executable> => ({
      execute: async () => 'ok',
      lastTokenUsage: { input_tokens: 100, output_tokens: 20, cost_usd: 0.0125 },
    }),
    onEnd: ({ usage }) => ends.push(usage?.cost_usd),
  });

  await call(tool, 'x');
  assert.deepEqual(ends, [0.0125]);
});

test('a failing invocation reports the error through onEnd', async () => {
  const ends: Array<{ error?: string }> = [];
  const tool = agentTool({
    name: 'probe',
    description: 'probe',
    spawn: async () => { throw new Error('no key'); },
    onEnd: (e) => ends.push({ error: e.error }),
  });

  await call(tool, 'x');
  assert.deepEqual(ends, [{ error: 'no key' }]);
});
