import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { transcriptReducer, emptyTranscript, MAX_REASONING_PER_STEP, MAX_REASONING_TOTAL, MAX_LIVE_TAIL } from './useTranscript.js';
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

describe('live buffer memory bound', () => {
  it('caps the live stream/reasoning buffers rather than growing them without limit', () => {
    // A run that goes long enough (an uncapped local model reasoning for an
    // hour) must not let state.stream/state.reasoning grow without bound —
    // that's the string V8 has to fully re-flatten on every single render
    // while it's live (see MAX_LIVE_TAIL's comment), which is what actually
    // exhausted the heap, not the "real" size of the text.
    const chunk = 'x'.repeat(1000);
    let state = emptyTranscript;
    for (let i = 0; i < 100; i++) {
      state = transcriptReducer(state, { type: 'append-stream', text: chunk });
      state = transcriptReducer(state, { type: 'append-reasoning', text: chunk });
    }
    assert.ok(state.stream.length <= MAX_LIVE_TAIL, `stream grew to ${state.stream.length}`);
    assert.ok(state.reasoning.length <= MAX_LIVE_TAIL, `reasoning grew to ${state.reasoning.length}`);
    // And it's a tail, not a truncated-from-the-front buffer losing the
    // newest tokens — the most recent chunk must still be at the end.
    assert.ok(state.stream.endsWith(chunk));
    assert.ok(state.reasoning.endsWith(chunk));
  });

  it('stays cheap over many appends instead of reprocessing the whole buffer each time', () => {
    // Regression guard for the actual bug: an unbounded live buffer means
    // every appended chunk pays a flatten cost proportional to everything
    // generated so far, which is O(n²) over the life of a long turn. Bounded
    // append-then-trim keeps each step cheap regardless of how long the turn
    // runs — this simulates a stream long enough that the old behaviour
    // would take double-digit seconds; bounded, it should be near-instant.
    const chunk = 'the quick brown fox jumps over the lazy dog. '.repeat(20); // ~940 chars
    let state = emptyTranscript;
    const start = Date.now();
    for (let i = 0; i < 5000; i++) {
      state = transcriptReducer(state, { type: 'append-reasoning', text: chunk });
    }
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2000, `expected well under 2s for 5000 chunks, took ${elapsed}ms`);
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

  it('a reset advances the epoch rather than restarting it', () => {
    const state = run([
      { type: 'replay' },
      { type: 'reset', messages: [row('1')] },
    ]);
    assert.ok(state.epoch > 1, 'a resize during a cleared session must still replay');
  });

  // Ink's <Static> renders items.slice(alreadyEmitted) and keeps that count in
  // component state, so a shorter list under the same key renders nothing at
  // all. /clear wiped the terminal and left it blank for exactly this reason.
  it('a reset to fewer rows still changes the render key', () => {
    const before = run([
      { type: 'push', message: row('1') },
      { type: 'push', message: row('2') },
      { type: 'push', message: row('3') },
    ]);
    const after = transcriptReducer(before, { type: 'reset', messages: [row('9')] });
    assert.notEqual(after.epoch, before.epoch);
    assert.equal(after.messages.length, 1);
  });

  it('a push does not change the key — appending is what Static is built for', () => {
    const before = run([{ type: 'push', message: row('1') }]);
    const after = transcriptReducer(before, { type: 'push', message: row('2') });
    assert.equal(after.epoch, before.epoch);
  });
});

describe('reasoning memory bound', () => {
  const thinking = (key: string, content: string): Message =>
    ({ key, role: 'reasoning', content });

  it('leaves visible rows untouched', () => {
    const state = run([{ type: 'push', message: row('1', 'visible') }]);
    assert.deepEqual(state.messages, [row('1', 'visible')]);
  });

  it('truncates one huge reasoning trace to its tail', () => {
    const trace = 'x'.repeat(MAX_REASONING_PER_STEP + 1000) + 'THE_END';
    const state = run([{ type: 'push', message: thinking('r', trace) }]);
    assert.equal(state.messages.length, 1);
    assert.equal(state.messages[0].content.length, MAX_REASONING_PER_STEP);
    assert.ok(state.messages[0].content.endsWith('THE_END'));
  });

  it('prunes oldest reasoning rows once the total exceeds the budget, in place', () => {
    // Rows stay under the per-step cap so the total is what trips the budget.
    const piece = 2000;
    const count = Math.ceil(MAX_REASONING_TOTAL / piece) + 1;
    const rows = Array.from({ length: count }, (_, i) => thinking(`r${i}`, 't'.repeat(piece)));
    const state = rows.reduce((s, m) => transcriptReducer(s, { type: 'push', message: m }), emptyTranscript);

    assert.equal(state.messages.length, count, 'in place — <Static> tracks by emitted index');
    assert.equal(state.messages[0].content, '', 'oldest reasoning freed');
    assert.equal(state.messages[count - 1].content, 't'.repeat(piece), 'newest reasoning kept');
  });

  it('frees old reasoning but leaves user rows alone', () => {
    const piece = 2000;
    const count = Math.ceil(MAX_REASONING_TOTAL / piece) + 1;
    let state = run([{ type: 'push', message: row('u', 'a question') }]);
    for (let i = 0; i < count; i++) {
      state = transcriptReducer(state, { type: 'push', message: thinking(`r${i}`, 't'.repeat(piece)) });
    }

    assert.deepEqual(state.messages[0], row('u', 'a question'), 'user row untouched');
    assert.equal(state.messages[1].content, '', 'first (oldest) reasoning dropped');
    assert.equal(state.messages[state.messages.length - 1].content, 't'.repeat(piece));
  });

  it('under budget keeps the same row instance (no wasted rewrites)', () => {
    const small = 'a thought '.repeat(3);
    const m = thinking('r', small);
    const state = run([{ type: 'push', message: m }]);
    assert.strictEqual(state.messages[0], m);
  });
});
