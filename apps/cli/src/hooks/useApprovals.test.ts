import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApprovalQueue } from './useApprovals.js';
import type { ApprovalRequest } from '@marshall/tools';

const req = (name: string): ApprovalRequest =>
  ({ toolName: name, description: name, detail: '' } as ApprovalRequest);

/**
 * The queue is a plain factory — `useApprovals` only pins one instance per mount.
 * Keeping the logic out of the hook is what makes it drivable without a render.
 */
const queue = createApprovalQueue;

describe('single approval', () => {
  it('shows the first request immediately', () => {
    const a = queue();
    assert.deepEqual(a.enqueue(req('write_file')).show, req('write_file'));
    assert.equal(a.pending, 1);
  });

  it('resolves the caller with the decision', async () => {
    const a = queue();
    const { promise } = a.enqueue(req('write_file'));
    a.resolve('approve');
    assert.equal(await promise, 'approve');
  });

  it('reports an empty queue once the last one is answered', () => {
    const a = queue();
    a.enqueue(req('write_file'));
    assert.deepEqual(a.resolve('approve'), { show: null });
    assert.equal(a.pending, 0);
  });
});

describe('parallel tool use', () => {
  it('shows only the first, and queues the rest', () => {
    const a = queue();
    assert.notEqual(a.enqueue(req('edit_file')).show, null);
    assert.equal(a.enqueue(req('run_shell')).show, null, 'second must not replace the one on screen');
    assert.equal(a.pending, 2);
  });

  it('chains to the next request as each is answered', () => {
    const a = queue();
    a.enqueue(req('edit_file'));
    a.enqueue(req('run_shell'));
    assert.deepEqual(a.resolve('approve'), { show: req('run_shell') });
    assert.deepEqual(a.resolve('deny'), { show: null });
  });

  it('resolves each caller with its own decision, in order', async () => {
    const a = queue();
    const first = a.enqueue(req('edit_file')).promise;
    const second = a.enqueue(req('run_shell')).promise;
    a.resolve('approve');
    a.resolve('deny');
    assert.deepEqual(await Promise.all([first, second]), ['approve', 'deny']);
  });
});

describe('deny all', () => {
  it('denies every queued caller and reports the count', async () => {
    const a = queue();
    const promises = [a.enqueue(req('edit_file')).promise, a.enqueue(req('run_shell')).promise];
    assert.equal(a.denyAll(), 2);
    assert.deepEqual(await Promise.all(promises), ['deny', 'deny']);
    assert.equal(a.pending, 0);
  });

  it('is a no-op on an empty queue, so esc with nothing pending says nothing', () => {
    assert.equal(queue().denyAll(), 0);
  });

  it('leaves nothing behind to resolve twice', () => {
    const a = queue();
    a.enqueue(req('edit_file'));
    a.denyAll();
    assert.equal(a.resolve('approve'), null, 'no pending request means no effect');
  });
});
