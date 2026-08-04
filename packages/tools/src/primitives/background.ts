import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { ChildProcess } from 'node:child_process';
import { scrubbedEnv, DEFAULT_MAX_OUTPUT_BYTES } from './spawn.js';

/**
 * Long-running shell commands that outlive the turn that started them.
 *
 * The distinction from `spawnSandboxed` is lifetime, and it drives every design
 * choice here. A foreground command is awaited, so its output can be buffered
 * from the start and returned once. A background command may run for an hour and
 * print continuously, so output is kept as two bounded views over the same
 * stream — the part nobody has read yet (`read`) and the most recent slice
 * regardless of reads (`tail`) — and the interesting end of an unbounded stream
 * is the *newest* part, so overflow drops the oldest bytes rather than the
 * newest as the foreground path does.
 */

/** 30 min. A background job still gets a ceiling — "runs forever" is a leak. */
export const DEFAULT_BACKGROUND_TIMEOUT_MS = 30 * 60_000;

/** Finished jobs kept for later inspection before the oldest are dropped. */
const MAX_RETAINED_FINISHED = 50;

const DROPPED_MARKER = '[...earlier output dropped — size limit reached...]\n';

export type JobStatus = 'running' | 'exited' | 'timed-out' | 'killed';

export interface BackgroundJob {
  id: string;
  /** The shell line, as the user approved it. */
  command: string;
  startedAt: number;
  status: JobStatus;
  /** Null until the process closes, and for a job that never started. */
  exitCode: number | null;
  endedAt?: number;
}

export interface JobOutput {
  stdout: string;
  stderr: string;
}

export interface StartJobOptions {
  command: string;
  cwd: string;
  timeoutMs?: number;
  /** Cap per stream, for each of the two views. Default: 64 KiB. */
  maxOutputBytes?: number;
}

export interface BackgroundJobs {
  start(options: StartJobOptions): BackgroundJob;
  get(id: string): BackgroundJob | undefined;
  list(): BackgroundJob[];
  /** Output since the previous `read`, then cleared. Undefined for unknown ids. */
  read(id: string): JobOutput | undefined;
  /** The most recent output, independent of what `read` has consumed. */
  tail(id: string): JobOutput | undefined;
  /** True if the job existed and was running. */
  kill(id: string): boolean;
  /** Stops everything. Call on session teardown — these are detached processes. */
  killAll(): void;
}

export interface BackgroundJobsOptions {
  /**
   * Fired when a job ends *on its own* — deliberately not for `kill`/`killAll`.
   * A caller that asked for the process to stop already knows it stopped, and in
   * the engine this callback wakes the agent up: being woken by your own
   * shutdown, or by every job dying at session teardown, is noise at best.
   */
  onExit?(job: BackgroundJob): void;
}

/**
 * One bounded, drainable view pair over a child's stdout or stderr.
 *
 * `pending` is what no one has read; `tail` is the recent slice. Both are capped
 * independently, both drop from the front, and the marker is applied at read
 * time rather than stored — appending it to the buffer would let repeated
 * overflow interleave marker fragments through the text.
 */
class StreamCapture {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  private pendingDropped = false;
  private tailText = '';
  private tailDropped = false;

  constructor(private readonly maxChars: number) {}

  push(chunk: Buffer): void {
    // Decoded incrementally: a multi-byte character split across two chunks
    // would otherwise land in the buffer as replacement characters.
    const text = this.decoder.write(chunk);
    if (!text) return;

    this.pending += text;
    if (this.pending.length > this.maxChars) {
      this.pending = this.pending.slice(-this.maxChars);
      this.pendingDropped = true;
    }

    this.tailText += text;
    if (this.tailText.length > this.maxChars) {
      this.tailText = this.tailText.slice(-this.maxChars);
      this.tailDropped = true;
    }
  }

  read(): string {
    const out = mark(this.pending, this.pendingDropped);
    this.pending = '';
    this.pendingDropped = false;
    return out;
  }

  tail(): string {
    return mark(this.tailText, this.tailDropped);
  }
}

function mark(text: string, dropped: boolean): string {
  return dropped && text ? DROPPED_MARKER + text : text;
}

interface JobRecord {
  job: BackgroundJob;
  child: ChildProcess;
  stdout: StreamCapture;
  stderr: StreamCapture;
  timer: NodeJS.Timeout;
  /** Set before a deliberate kill so `close` reports the right status. */
  intent: 'timed-out' | 'killed' | null;
}

export function createBackgroundJobs(options: BackgroundJobsOptions = {}): BackgroundJobs {
  const records = new Map<string, JobRecord>();
  let counter = 0;

  /** Ids are `job1`, `job2`, … rather than uuids: the model has to echo these
   *  back into `shell_output`, and short readable ones survive that better. */
  const nextId = () => `job${++counter}`;

  const killGroup = (child: ChildProcess) => {
    // Negative pid targets the whole group — `sh -c "npm test"` is a shell with
    // children, and killing only the shell orphans them.
    try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  };

  const finish = (rec: JobRecord, exitCode: number | null) => {
    if (rec.job.status !== 'running') return;
    clearTimeout(rec.timer);
    rec.job.status = rec.intent ?? 'exited';
    rec.job.exitCode = exitCode;
    rec.job.endedAt = Date.now();
    prune();
    if (rec.intent === null || rec.intent === 'timed-out') options.onExit?.({ ...rec.job });
  };

  /** Finished jobs hold two capped buffers each; a long session that starts many
   *  of them would otherwise grow without bound. Running jobs are never dropped. */
  const prune = () => {
    const finished = [...records.values()]
      .filter(r => r.job.status !== 'running')
      .sort((a, b) => (a.job.endedAt ?? 0) - (b.job.endedAt ?? 0));
    for (const rec of finished.slice(0, finished.length - MAX_RETAINED_FINISHED)) {
      records.delete(rec.job.id);
    }
  };

  return {
    start({ command, cwd, timeoutMs, maxOutputBytes }) {
      const maxChars = maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
      const job: BackgroundJob = {
        id: nextId(),
        command,
        startedAt: Date.now(),
        status: 'running',
        exitCode: null,
      };

      const child = spawn('sh', ['-c', command], {
        cwd,
        env: scrubbedEnv(),
        detached: true,
        stdio: 'pipe',
      });

      const rec: JobRecord = {
        job,
        child,
        stdout: new StreamCapture(maxChars),
        stderr: new StreamCapture(maxChars),
        intent: null,
        timer: setTimeout(() => {
          rec.intent = 'timed-out';
          killGroup(child);
        }, timeoutMs ?? DEFAULT_BACKGROUND_TIMEOUT_MS),
      };
      // Nothing should be kept alive purely by a background job's timer: on quit
      // the process must be free to exit once killAll has run.
      rec.timer.unref?.();

      child.stdout?.on('data', (chunk: Buffer) => rec.stdout.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => rec.stderr.push(chunk));
      child.on('close', (code) => finish(rec, code));
      child.on('error', (err) => {
        rec.stderr.push(Buffer.from(`${err.message}\n`));
        finish(rec, null);
      });

      records.set(job.id, rec);
      return { ...job };
    },

    get(id) {
      const rec = records.get(id);
      return rec ? { ...rec.job } : undefined;
    },

    list() {
      return [...records.values()].map(r => ({ ...r.job }));
    },

    read(id) {
      const rec = records.get(id);
      if (!rec) return undefined;
      return { stdout: rec.stdout.read(), stderr: rec.stderr.read() };
    },

    tail(id) {
      const rec = records.get(id);
      if (!rec) return undefined;
      return { stdout: rec.stdout.tail(), stderr: rec.stderr.tail() };
    },

    kill(id) {
      const rec = records.get(id);
      if (!rec || rec.job.status !== 'running') return false;
      rec.intent = 'killed';
      killGroup(rec.child);
      return true;
    },

    killAll() {
      for (const rec of records.values()) {
        if (rec.job.status !== 'running') continue;
        rec.intent = 'killed';
        killGroup(rec.child);
      }
    },
  };
}
