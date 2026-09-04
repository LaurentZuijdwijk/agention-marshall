import { Tool } from '@agentionai/agents/core';
import type { ToolInputSchema } from '@agentionai/agents/core';
import type { ToolConfig } from '../types.js';
import type { BackgroundJob, BackgroundJobs, JobOutput } from '../primitives/background.js';

/**
 * The read/stop half of backgrounded shell commands — `run_shell` starts them.
 *
 * None of these go through `withApproval`. Reading output is inert, and stopping
 * a job is inside the blast radius the user already approved when they let the
 * command start: making the agent ask permission to clean up after itself would
 * mostly train it not to bother.
 */
export function createJobTools(config: ToolConfig): Tool<string>[] {
  const { jobs } = config;
  if (!jobs) return [];

  return [
    tool({
      name: 'shell_output',
      description:
        'Read output from a background shell job started with run_shell. Returns only what ' +
        'has arrived since the last read, plus the job status. Use it to check on a job ' +
        'mid-run; you do not need it to learn that a job finished, which is reported to you.',
      properties: {
        job_id: { type: 'string', description: 'The job id returned by run_shell, e.g. "job1"' },
      },
      required: ['job_id'],
      execute: async ({ job_id }) => describeRead(jobs, String(job_id)),
    }),

    tool({
      name: 'shell_kill',
      description:
        'Stop a running background shell job. Use it when a job is no longer needed — a dev ' +
        'server you are done with, or a run made obsolete by a later change.',
      properties: {
        job_id: { type: 'string', description: 'The job id returned by run_shell, e.g. "job1"' },
      },
      required: ['job_id'],
      execute: async ({ job_id }) => {
        const id = String(job_id);
        const job = jobs.get(id);
        if (!job) return unknownJob(jobs, id);
        if (!jobs.kill(id)) {
          return `Job "${id}" was already ${job.status} (exit code ${job.exitCode ?? 'null'}).`;
        }
        return `Killed job "${id}": ${job.command}`;
      },
    }),

    tool({
      name: 'shell_list',
      description: 'List background shell jobs from this session with their status and runtime.',
      properties: {},
      required: [],
      execute: async () => {
        const all = jobs.list();
        if (all.length === 0) return 'No background jobs in this session.';
        return all.map(summarise).join('\n');
      },
    }),
  ];
}

interface JobToolSpec {
  name: string;
  description: string;
  properties: Record<string, unknown>;
  required: string[];
  execute: (input: Record<string, unknown>) => Promise<string>;
}

function tool(spec: JobToolSpec): Tool<string> {
  return new Tool<string>({
    name: spec.name,
    description: spec.description,
    inputSchema: {
      type: 'object',
      properties: spec.properties,
      required: spec.required,
    } as unknown as ToolInputSchema,
    execute: spec.execute,
  });
}

function describeRead(jobs: BackgroundJobs, id: string): string {
  const job = jobs.get(id);
  if (!job) return unknownJob(jobs, id);

  const output = jobs.read(id);
  const parts = [summarise(job)];
  const body = formatOutput(output);
  parts.push(body || '(no new output since the last read)');
  return parts.join('\n\n');
}

function unknownJob(jobs: BackgroundJobs, id: string): string {
  const known = jobs.list().map(j => j.id);
  return known.length
    ? `No background job "${id}". Known jobs: ${known.join(', ')}.`
    : `No background job "${id}" — nothing has been backgrounded in this session.`;
}

export function formatOutput(output: JobOutput | undefined): string {
  if (!output) return '';
  const parts: string[] = [];
  if (output.stdout) parts.push(`stdout:\n${output.stdout}`);
  if (output.stderr) parts.push(`stderr:\n${output.stderr}`);
  return parts.join('\n\n');
}

/** One line describing a job — shared by shell_list, shell_output and the
 *  completion report the engine feeds back into history. */
export function summarise(job: BackgroundJob): string {
  const elapsed = ((job.endedAt ?? Date.now()) - job.startedAt) / 1000;
  const state = job.status === 'running'
    ? `running for ${elapsed.toFixed(1)}s`
    : `${job.status} with exit code ${job.exitCode ?? 'null'} after ${elapsed.toFixed(1)}s`;
  return `${job.id}: ${job.command} — ${state}`;
}
