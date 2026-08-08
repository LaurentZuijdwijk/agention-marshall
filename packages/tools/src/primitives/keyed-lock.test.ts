import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKeyedLock } from './keyed-lock.js';

/** Resolves after `ms`, recording entry and exit around the wait. */
function tracked(log: string[], label: string, ms: number) {
  return async () => {
    log.push(`${label}:start`);
    await new Promise(r => setTimeout(r, ms));
    log.push(`${label}:end`);
    return label;
  };
}

test('work on the same key never overlaps', async () => {
  const lock = createKeyedLock();
  const log: string[] = [];

  await Promise.all([
    lock('a', tracked(log, 'first', 20)),
    lock('a', tracked(log, 'second', 1)),
  ]);

  // The whole point: `second` must not start until `first` has finished, even
  // though it is far quicker and was queued immediately after.
  assert.deepEqual(log, ['first:start', 'first:end', 'second:start', 'second:end']);
});

test('work on different keys still runs in parallel', async () => {
  const lock = createKeyedLock();
  const log: string[] = [];

  await Promise.all([
    lock('a', tracked(log, 'a', 20)),
    lock('b', tracked(log, 'b', 1)),
  ]);

  // Interleaved, so batching edits across different files stays concurrent.
  assert.deepEqual(log, ['a:start', 'b:start', 'b:end', 'a:end']);
});

test('results and rejections both reach their own caller', async () => {
  const lock = createKeyedLock();

  const ok = await lock('a', async () => 'value');
  assert.equal(ok, 'value');

  await assert.rejects(
    () => lock('a', async () => { throw new Error('boom'); }),
    /boom/,
  );
});

test('a rejection does not wedge later work on the same key', async () => {
  const lock = createKeyedLock();

  const failed = lock('a', async () => { throw new Error('boom'); });
  const after = lock('a', async () => 'still runs');

  await assert.rejects(() => failed, /boom/);
  assert.equal(await after, 'still runs',
    'a failed holder must not block everything queued behind it');
});

test('a key still serialises correctly after its queue has drained', async () => {
  const lock = createKeyedLock();

  await lock('a', async () => 'done');
  // Let the internal cleanup run — it drops the drained key on a microtask.
  await Promise.resolve();
  await Promise.resolve();

  // The cleanup must not leave the key in a state where the next pair of calls
  // skips the queue.
  const log: string[] = [];
  await Promise.all([
    lock('a', tracked(log, 'x', 10)),
    lock('a', tracked(log, 'y', 1)),
  ]);
  assert.deepEqual(log, ['x:start', 'x:end', 'y:start', 'y:end']);
});
