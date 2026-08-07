import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createQuestionQueue } from './useQuestions.js';
import type { AskRequest } from '@agentionai/marshall-tools';

const req = (question: string): AskRequest => ({ question });

/** Mirrors useApprovals: logic lives in a plain factory so it is drivable without a render. */
const queue = createQuestionQueue;

describe('single question', () => {
  it('shows the first question immediately', () => {
    const q = queue();
    assert.deepEqual(q.enqueue(req('Pick?')).show, req('Pick?'));
    assert.equal(q.pending, 1);
  });

  it('resolves the caller with the answer', async () => {
    const q = queue();
    const { promise } = q.enqueue(req('Pick?'));
    q.resolve('left');
    assert.equal(await promise, 'left');
  });

  it('reports an empty queue once the last is answered', () => {
    const q = queue();
    q.enqueue(req('Pick?'));
    assert.deepEqual(q.resolve('left'), { show: null });
    assert.equal(q.pending, 0);
  });
});

describe('parallel tool use', () => {
  it('shows only the first, and queues the rest', () => {
    const q = queue();
    assert.notEqual(q.enqueue(req('One?')).show, null);
    assert.equal(q.enqueue(req('Two?')).show, null, 'second must not replace the one on screen');
    assert.equal(q.pending, 2);
  });

  it('chains to the next question as each is answered', () => {
    const q = queue();
    q.enqueue(req('One?'));
    q.enqueue(req('Two?'));
    assert.deepEqual(q.resolve('left'), { show: req('Two?') });
    assert.deepEqual(q.resolve('right'), { show: null });
  });

  it('resolves each caller with its own answer, in order', async () => {
    const q = queue();
    const first = q.enqueue(req('One?')).promise;
    const second = q.enqueue(req('Two?')).promise;
    q.resolve('left');
    q.resolve('right');
    assert.deepEqual(await Promise.all([first, second]), ['left', 'right']);
  });
});

describe('cancel all', () => {
  it('answers every queued caller with the no-answer sentinel and reports the count', async () => {
    const q = queue();
    const promises = [q.enqueue(req('One?')).promise, q.enqueue(req('Two?')).promise];
    assert.equal(q.cancelAll(), 2);
    assert.deepEqual(await Promise.all(promises), ['(the user did not answer)', '(the user did not answer)']);
    assert.equal(q.pending, 0);
  });

  it('is a no-op on an empty queue', () => {
    assert.equal(queue().cancelAll(), 0);
  });

  it('leaves nothing behind to resolve twice', () => {
    const q = queue();
    q.enqueue(req('One?'));
    q.cancelAll();
    assert.equal(q.resolve('left'), null, 'no pending question means no effect');
  });
});
