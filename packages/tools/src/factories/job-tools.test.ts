import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createJobTools } from './job-tools.js';
import { createShellTool } from './shell-tool.js';
import { createBackgroundJobs } from '../primitives/background.js';
import type { BackgroundJob, BackgroundJobs } from '../primitives/background.js';
import type { ToolConfig } from '../types.js';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'marshall-jobtools-test-'));
}

interface Belt {
  jobs: BackgroundJobs;
  shell: ReturnType<typeof createShellTool>;
  tools: Map<string, ReturnType<typeof createJobTools>[number]>;
  exited: Promise<BackgroundJob>;
  workspaceRoot: string;
}

function belt(overrides: Partial<ToolConfig> = {}): Belt {
  let resolve!: (job: BackgroundJob) => void;
  const exited = new Promise<BackgroundJob>((r) => { resolve = r; });
  const jobs = createBackgroundJobs({ onExit: resolve });
  const workspaceRoot = tempRoot();
  const config: ToolConfig = {
    workspaceRoot,
    approval: async () => 'approve',
    jobs,
    ...overrides,
  };
  return {
    jobs,
    workspaceRoot,
    exited,
    shell: createShellTool(config),
    tools: new Map(createJobTools(config).map(t => [t.name, t])),
  };
}

const run = (tool: { execute: Function }, input: Record<string, unknown>) =>
  tool.execute('a', 'b', input, 'id') as Promise<string>;

test('no job tools exist when no registry is injected', () => {
  const tools = createJobTools({ workspaceRoot: tempRoot(), approval: async () => 'approve' });
  assert.deepEqual(tools, []);
});

test('run_shell with background returns a job id without waiting', async () => {
  const { shell, jobs } = belt();
  const started = Date.now();
  const result = await run(shell, { command: 'sleep 30', background: true });
  assert.ok(Date.now() - started < 2000, 'must not block on the command');
  assert.match(result, /job1/);
  assert.equal(jobs.get('job1')!.status, 'running');
  jobs.killAll();
});

test('run_shell without background still waits and reports the exit code', async () => {
  const { shell } = belt();
  const result = await run(shell, { command: 'echo sync' });
  assert.match(result, /sync/);
  assert.match(result, /exit code: 0/);
});

test('a backgrounded command survives the task signal being aborted', async () => {
  const controller = new AbortController();
  const { shell, jobs } = belt({ signal: controller.signal });
  await run(shell, { command: 'sleep 30', background: true });
  controller.abort();
  await new Promise(r => setTimeout(r, 50));
  assert.equal(jobs.get('job1')!.status, 'running', 'the turn ending must not kill the job');
  jobs.killAll();
});

test('the approval prompt says the command will run in the background', async () => {
  const seen: string[] = [];
  const { shell, jobs } = belt({ approval: async (req) => { seen.push(req.detail); return 'approve'; } });
  await run(shell, { command: 'sleep 30', background: true });
  assert.match(seen[0], /background/);
  jobs.killAll();
});

test('the command policy applies to backgrounded commands too', async () => {
  const { shell, jobs } = belt();
  const result = await run(shell, { command: 'rm -rf /', background: true });
  assert.match(result, /blocked by policy/);
  assert.equal(jobs.list().length, 0);
});

test('shell_output returns new output and the job status', async () => {
  const { shell, tools, exited } = belt();
  await run(shell, { command: 'echo hello-bg', background: true });
  await exited;
  const result = await run(tools.get('shell_output')!, { job_id: 'job1' });
  assert.match(result, /hello-bg/);
  assert.match(result, /exited with exit code 0/);
});

test('shell_output reports when nothing new has arrived', async () => {
  const { shell, tools, exited } = belt();
  await run(shell, { command: 'echo once', background: true });
  await exited;
  await run(tools.get('shell_output')!, { job_id: 'job1' });
  const second = await run(tools.get('shell_output')!, { job_id: 'job1' });
  assert.match(second, /no new output/);
});

test('shell_output names the known jobs for an unknown id', async () => {
  const { shell, tools, jobs } = belt();
  await run(shell, { command: 'sleep 30', background: true });
  const result = await run(tools.get('shell_output')!, { job_id: 'job9' });
  assert.match(result, /No background job "job9"/);
  assert.match(result, /job1/);
  jobs.killAll();
});

test('shell_kill stops a running job', async () => {
  const { shell, tools, jobs } = belt();
  await run(shell, { command: 'sleep 30', background: true });
  const result = await run(tools.get('shell_kill')!, { job_id: 'job1' });
  assert.match(result, /Killed job "job1"/);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(jobs.get('job1')!.status, 'killed');
});

test('shell_kill on a finished job says so instead of failing', async () => {
  const { shell, tools, exited } = belt();
  await run(shell, { command: 'true', background: true });
  await exited;
  const result = await run(tools.get('shell_kill')!, { job_id: 'job1' });
  assert.match(result, /already exited/);
});

test('shell_list reports every job in the session', async () => {
  const { shell, tools, jobs, exited } = belt();
  await run(shell, { command: 'true', background: true });
  await exited;
  await run(shell, { command: 'sleep 30', background: true });
  const result = await run(tools.get('shell_list')!, {});
  assert.match(result, /job1: true — exited/);
  assert.match(result, /job2: sleep 30 — running/);
  jobs.killAll();
});

test('shell_list says so when nothing has been backgrounded', async () => {
  const { tools } = belt();
  assert.match(await run(tools.get('shell_list')!, {}), /No background jobs/);
});
