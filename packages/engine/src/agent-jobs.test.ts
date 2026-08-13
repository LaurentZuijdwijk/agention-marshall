import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentJobs, summariseAgentJob } from './agent-jobs.js';
import type { AgentJob, StartAgentJobOptions } from './agent-jobs.js';

/** A job whose completion this test controls. */
function deferred() {
  let resolve!: (value: string) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const opts = (over: Partial<StartAgentJobOptions> = {}): StartAgentJobOptions => ({
  brief: 'do the thing',
  tier: 'fast',
  toolset: 'edit',
  label: 'openrouter/some-model',
  run: async () => 'finished',
  ...over,
});

/** Lets the microtask queue drain, which is when `run` settles. */
const settled = () => new Promise(resolve => setImmediate(resolve));

describe('createAgentJobs', () => {
  it('returns an id without waiting for the work', async () => {
    const gate = deferred();
    const jobs = createAgentJobs();
    const job = jobs.start(opts({ run: () => gate.promise }));

    // The whole point of the registry: `start` is synchronous even though the
    // agent behind it may run for minutes.
    assert.equal(job.id, 'agent1');
    assert.equal(job.status, 'running');
    assert.equal(jobs.get('agent1')?.status, 'running');

    gate.resolve('done at last');
    await settled();
    assert.equal(jobs.get('agent1')?.status, 'done');
  });

  it('reports a finished job once and only once', async () => {
    const done: AgentJob[] = [];
    const jobs = createAgentJobs({ onDone: (job) => { done.push(job); } });
    jobs.start(opts({ run: async () => 'the summary' }));
    await settled();

    assert.equal(done.length, 1);
    assert.equal(done[0].result, 'the summary');
    // Drained, so the completion report and a polling `agent_output` cannot
    // both spend the parent's context on the same text.
    assert.equal(jobs.read('agent1'), 'the summary');
    assert.equal(jobs.read('agent1'), undefined);
    // Still visibly successful after the result has been taken.
    assert.equal(jobs.get('agent1')?.status, 'done');
  });

  it('turns a thrown agent into a failed job rather than a crash', async () => {
    const jobs = createAgentJobs();
    jobs.start(opts({ run: async () => { throw new Error('provider said no'); } }));
    await settled();

    const job = jobs.get('agent1');
    assert.equal(job?.status, 'failed');
    assert.equal(job?.error, 'provider said no');
  });

  it('aborts the job signal on kill, so the agent tools stop working', async () => {
    const gate = deferred();
    let seen: AbortSignal | undefined;
    const jobs = createAgentJobs();
    jobs.start(opts({ run: ({ signal }) => { seen = signal; return gate.promise; } }));
    await settled();

    assert.equal(seen?.aborted, false);
    assert.equal(jobs.kill('agent1'), true);
    assert.equal(seen?.aborted, true);
    assert.equal(jobs.get('agent1')?.status, 'killed');
    // Killing something already stopped is not an error, just nothing to do.
    assert.equal(jobs.kill('agent1'), false);
  });

  it('does not let a killed job report back when it eventually settles', async () => {
    const gate = deferred();
    const done: AgentJob[] = [];
    const jobs = createAgentJobs({ onDone: (job) => { done.push(job); } });
    jobs.start(opts({ run: () => gate.promise }));
    await settled();
    jobs.kill('agent1');

    // The agent's own loop cannot be stopped today, so it finishes and answers
    // into a session that has moved on. That answer must stay where it fell.
    gate.resolve('work nobody asked for any more');
    await settled();

    assert.equal(done.length, 0, 'a killed job must not wake the parent');
    assert.equal(jobs.get('agent1')?.status, 'killed');
    assert.equal(jobs.read('agent1'), undefined);
  });

  it('records a cancelled run as killed, not as failed', async () => {
    const done: AgentJob[] = [];
    const jobs = createAgentJobs({ onDone: (job) => { done.push(job); } });
    // What the library actually does now: abort the signal and the run rejects
    // with an AbortError. That rejection is the kill landing, not a failure.
    jobs.start(opts({
      run: ({ signal }) => new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('Run cancelled'), { name: 'AbortError' }));
        });
      }),
    }));
    await settled();

    jobs.kill('agent1');
    await settled();

    const job = jobs.get('agent1');
    assert.equal(job?.status, 'killed');
    assert.equal(job?.error, undefined, 'a cancellation is not an error the parent should read');
    assert.equal(done.length, 0);
  });

  it('stops a job that runs past its ceiling, and says so', async () => {
    const done: AgentJob[] = [];
    const jobs = createAgentJobs({ onDone: (job) => { done.push(job); } });
    let signal: AbortSignal | undefined;
    jobs.start(opts({
      timeoutMs: 5,
      run: (ctx) => { signal = ctx.signal; return new Promise<string>(() => {}); },
    }));
    await new Promise(resolve => setTimeout(resolve, 30));

    const job = jobs.get('agent1');
    assert.equal(job?.status, 'timed-out');
    assert.equal(signal?.aborted, true);
    // Unlike a kill, nobody asked for this — the parent has to hear about work
    // that stopped short, or it waits forever for a report that never comes.
    assert.equal(done.length, 1);
    assert.equal(done[0].status, 'timed-out');
  });

  it('does not fire the ceiling on a job that already finished', async () => {
    const done: AgentJob[] = [];
    const jobs = createAgentJobs({ onDone: (job) => { done.push(job); } });
    jobs.start(opts({ timeoutMs: 5, run: async () => 'quick' }));
    await new Promise(resolve => setTimeout(resolve, 30));

    assert.equal(jobs.get('agent1')?.status, 'done');
    assert.equal(done.length, 1, 'a cleared timer cannot report a second ending');
  });

  it('starts no ceiling when none is given — it runs until told to stop', async () => {
    const done: AgentJob[] = [];
    const jobs = createAgentJobs({ onDone: (job) => { done.push(job); } });
    jobs.start(opts({ run: () => new Promise<string>(() => {}) }));
    await new Promise(resolve => setTimeout(resolve, 30));

    assert.equal(jobs.get('agent1')?.status, 'running', 'no configured ceiling must not time out');
    assert.equal(done.length, 0, 'nothing fired onDone');
    jobs.killAll();
    assert.equal(jobs.get('agent1')?.status, 'killed');
  });

  it('kills everything still running, and leaves the finished alone', async () => {
    const gate = deferred();
    const jobs = createAgentJobs();
    jobs.start(opts({ run: async () => 'quick' }));
    jobs.start(opts({ run: () => gate.promise }));
    await settled();

    jobs.killAll();
    assert.equal(jobs.get('agent1')?.status, 'done');
    assert.equal(jobs.get('agent2')?.status, 'killed');
  });

  it('keeps a bounded trail of what a job has been doing', () => {
    const gate = deferred();
    const jobs = createAgentJobs();
    jobs.start(opts({ run: () => gate.promise }));

    for (let i = 0; i < 20; i++) jobs.note('agent1', `read_file f${i}.ts`);
    const trail = jobs.activity('agent1');
    assert.equal(trail.length, 12);
    assert.equal(trail.at(-1), 'read_file f19.ts', 'the newest step is the interesting one');
    assert.equal(trail[0], 'read_file f8.ts');
  });

  it('ignores notes for a job that has already stopped', async () => {
    const jobs = createAgentJobs();
    jobs.start(opts({ run: async () => 'done' }));
    await settled();

    jobs.note('agent1', 'a late tool result');
    assert.deepEqual(jobs.activity('agent1'), []);
  });

  it('numbers jobs so the model can echo the id back', () => {
    const gate = deferred();
    const jobs = createAgentJobs();
    assert.equal(jobs.start(opts({ run: () => gate.promise })).id, 'agent1');
    assert.equal(jobs.start(opts({ run: () => gate.promise })).id, 'agent2');
    assert.deepEqual(jobs.list().map(j => j.id), ['agent1', 'agent2']);
  });
});

describe('summariseAgentJob', () => {
  it('names the tier, model and toolset, because those are what the user consented to', () => {
    const job: AgentJob = {
      id: 'agent1',
      brief: 'restyle the header',
      tier: 'fast',
      toolset: 'edit',
      label: 'openrouter/some-model',
      startedAt: Date.now() - 2_000,
      status: 'running',
    };
    const line = summariseAgentJob(job);
    assert.match(line, /^agent1 \(fast, openrouter\/some-model, edit\)/);
    assert.match(line, /running for \d+\.\ds$/);
  });
});
