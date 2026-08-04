import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBackgroundJobs } from './background.js';
import type { BackgroundJob, BackgroundJobs } from './background.js';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'marshall-jobs-test-'));
}

/** Resolves on the job's own exit callback, so nothing here polls on a timer. */
function onExit(): { jobs: BackgroundJobs; exited: Promise<BackgroundJob> } {
  let resolve!: (job: BackgroundJob) => void;
  const exited = new Promise<BackgroundJob>((r) => { resolve = r; });
  const jobs = createBackgroundJobs({ onExit: resolve });
  return { jobs, exited };
}

test('start returns immediately and reports the job as running', () => {
  const jobs = createBackgroundJobs();
  const job = jobs.start({ command: 'sleep 5', cwd: tempRoot() });
  assert.equal(job.status, 'running');
  assert.match(job.id, /^job\d+$/);
  jobs.killAll();
});

test('notifies on exit with the exit code', async () => {
  const { jobs, exited } = onExit();
  jobs.start({ command: 'exit 3', cwd: tempRoot() });
  const job = await exited;
  assert.equal(job.status, 'exited');
  assert.equal(job.exitCode, 3);
  assert.ok(job.endedAt !== undefined);
});

test('captures output produced after the start call returned', async () => {
  const { jobs, exited } = onExit();
  const started = jobs.start({ command: 'echo out; echo err >&2', cwd: tempRoot() });
  await exited;
  const output = jobs.read(started.id);
  assert.match(output!.stdout, /out/);
  assert.match(output!.stderr, /err/);
});

test('read is incremental — a second read sees only new output', async () => {
  const { jobs, exited } = onExit();
  const started = jobs.start({ command: 'echo first', cwd: tempRoot() });
  await exited;
  assert.match(jobs.read(started.id)!.stdout, /first/);
  assert.equal(jobs.read(started.id)!.stdout, '');
});

test('tail keeps the recent output that read already consumed', async () => {
  const { jobs, exited } = onExit();
  const started = jobs.start({ command: 'echo kept', cwd: tempRoot() });
  await exited;
  jobs.read(started.id);
  assert.match(jobs.tail(started.id)!.stdout, /kept/);
});

test('overflow drops the oldest output, keeping the newest', async () => {
  const { jobs, exited } = onExit();
  const started = jobs.start({
    command: 'for i in 1 2 3 4 5 6 7 8 9 10; do echo "line$i"; done',
    cwd: tempRoot(),
    maxOutputBytes: 24,
  });
  await exited;
  const { stdout } = jobs.read(started.id)!;
  assert.match(stdout, /line10/, 'newest output survives');
  assert.doesNotMatch(stdout, /line1\n/, 'oldest output is dropped');
  assert.match(stdout, /earlier output dropped/);
});

test('kill stops a running job and does not fire onExit', async () => {
  let notified = false;
  const jobs = createBackgroundJobs({ onExit: () => { notified = true; } });
  const started = jobs.start({ command: 'sleep 30', cwd: tempRoot() });
  assert.equal(jobs.kill(started.id), true);

  // The kill is asynchronous; wait for the child to actually close.
  await waitFor(() => jobs.get(started.id)!.status !== 'running');
  assert.equal(jobs.get(started.id)!.status, 'killed');
  assert.equal(notified, false, 'a kill you asked for should not wake the caller');
});

test('kill reports false for a job that already finished', async () => {
  const { jobs, exited } = onExit();
  const started = jobs.start({ command: 'true', cwd: tempRoot() });
  await exited;
  assert.equal(jobs.kill(started.id), false);
});

test('a timeout kills the job and does notify', async () => {
  const { jobs, exited } = onExit();
  jobs.start({ command: 'sleep 30', cwd: tempRoot(), timeoutMs: 50 });
  const job = await exited;
  assert.equal(job.status, 'timed-out');
});

test('killAll stops every running job', async () => {
  const jobs = createBackgroundJobs();
  const a = jobs.start({ command: 'sleep 30', cwd: tempRoot() });
  const b = jobs.start({ command: 'sleep 30', cwd: tempRoot() });
  jobs.killAll();
  await waitFor(() => jobs.list().every(j => j.status !== 'running'));
  assert.equal(jobs.get(a.id)!.status, 'killed');
  assert.equal(jobs.get(b.id)!.status, 'killed');
});

test('runs in the given workspace directory', async () => {
  const cwd = tempRoot();
  const { jobs, exited } = onExit();
  const started = jobs.start({ command: 'pwd', cwd });
  await exited;
  assert.match(jobs.read(started.id)!.stdout, new RegExp(cwd.replace(/[/\\]/g, '[$/\\\\]')));
});

test('scrubs the environment', async () => {
  process.env.MARSHALL_JOB_LEAK_TEST = 'leaked';
  try {
    const { jobs, exited } = onExit();
    const started = jobs.start({ command: 'echo "[$MARSHALL_JOB_LEAK_TEST]"', cwd: tempRoot() });
    await exited;
    assert.match(jobs.read(started.id)!.stdout, /\[\]/);
  } finally {
    delete process.env.MARSHALL_JOB_LEAK_TEST;
  }
});

test('unknown ids read as undefined rather than throwing', () => {
  const jobs = createBackgroundJobs();
  assert.equal(jobs.get('nope'), undefined);
  assert.equal(jobs.read('nope'), undefined);
  assert.equal(jobs.tail('nope'), undefined);
  assert.equal(jobs.kill('nope'), false);
});

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise(r => setTimeout(r, 10));
  }
}
