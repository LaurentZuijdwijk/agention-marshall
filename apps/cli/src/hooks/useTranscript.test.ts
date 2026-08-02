import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { transcriptReducer, emptyTranscript } from './useTranscript.js';
import type { TranscriptState, TranscriptAction } from './useTranscript.js';
import type { Message } from '../view/message.js';

const row = (key: string, content = ''): Message => ({ key, role: 'info', content });

/** Fold a sequence of actions, which is how the hook actually drives it. */
function run(actions: TranscriptAction[], from: TranscriptState = emptyTranscript): TranscriptState {
  return actions.reduce(transcriptReducer, from);
}

describe('committed rows', () => {
  it('appends in order', () => {
    const state = run([
      { type: 'push', message: row('1', 'a') },
      { type: 'push', message: row('2', 'b') },
    ]);
    assert.deepEqual(state.messages.map(m => m.content), ['a', 'b']);
  });

  it('never mutates the previous state — <Static> diffs by identity', () => {
    const before = run([{ type: 'push', message: row('1') }]);
    const after = transcriptReducer(before, { type: 'push', message: row('2') });
    assert.notEqual(before.messages, after.messages);
    assert.equal(before.messages.length, 1, 'the earlier state must be untouched');
  });

  it('reset replaces the rows and drops the live buffers with them', () => {
    const state = run([
      { type: 'push', message: row('1', 'old') },
      { type: 'append-stream', text: 'half a sentence' },
      { type: 'append-reasoning', text: 'thinking' },
      { type: 'reset', messages: [row('2', 'fresh')] },
    ]);
    assert.deepEqual(state.messages.map(m => m.content), ['fresh']);
    assert.equal(state.stream, '', 'a cleared session must not leave a live buffer behind');
    assert.equal(state.reasoning, '');
  });
});

describe('live buffers', () => {
  it('accumulates streamed tokens', () => {
    const state = run([
      { type: 'append-stream', text: 'Hel' },
      { type: 'append-stream', text: 'lo' },
    ]);
    assert.equal(state.stream, 'Hello');
  });

  it('accumulates reasoning independently of the answer', () => {
    const state = run([
      { type: 'append-stream', text: 'answer' },
      { type: 'append-reasoning', text: 'thought' },
    ]);
    assert.equal(state.stream, 'answer');
    assert.equal(state.reasoning, 'thought');
  });

  it('clearing one leaves the other alone', () => {
    const state = run([
      { type: 'append-stream', text: 'answer' },
      { type: 'append-reasoning', text: 'thought' },
      { type: 'clear-stream' },
    ]);
    assert.equal(state.stream, '');
    assert.equal(state.reasoning, 'thought');
  });

  it('clearing an already-empty buffer returns the same object', () => {
    // Identity matters: a fresh object on every no-op clear re-renders the live
    // region for nothing, and that region is the one that mis-erases.
    const state = run([{ type: 'push', message: row('1') }]);
    assert.equal(transcriptReducer(state, { type: 'clear-stream' }), state);
    assert.equal(transcriptReducer(state, { type: 'clear-reasoning' }), state);
  });

  it('live buffers are not committed rows', () => {
    const state = run([
      { type: 'append-stream', text: 'streaming…' },
      { type: 'append-reasoning', text: 'thinking…' },
    ]);
    assert.deepEqual(state.messages, [], 'nothing streams into the committed transcript');
  });
});

describe('replay', () => {
  it('bumps the epoch without disturbing anything else', () => {
    const before = run([
      { type: 'push', message: row('1', 'a') },
      { type: 'append-stream', text: 'live' },
    ]);
    const after = transcriptReducer(before, { type: 'replay' });
    assert.equal(after.epoch, before.epoch + 1);
    assert.equal(after.messages, before.messages, 'rows are reused, only the render key changes');
    assert.equal(after.stream, 'live');
  });

  it('epoch survives a reset, so a resize during a cleared session still replays', () => {
    const state = run([
      { type: 'replay' },
      { type: 'reset', messages: [row('1')] },
    ]);
    assert.equal(state.epoch, 1);
  });
});
