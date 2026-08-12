import type { Tier } from './config.js';

/**
 * Spawned agents that outlive the turn that started them.
 *
 * The shape deliberately mirrors `BackgroundJobs` for shell commands, because
 * the model has to drive both and one idiom is cheaper to learn than two:
 * something starts, you get an id back, you can list, read and kill it, and you
 * are told when it ends without having to poll. What differs is what a "job"
 * produces. A shell command emits an unbounded stream, so its registry is built
 * around two bounded views over it; an agent produces exactly one final message,
 * so this one is built around a single result plus a trail of what it did on the
 * way there.
 *
 * Deliberately knows nothing about agents, models or tools: it takes a `run`
 * thunk and stores what comes back. That keeps the lifetime rules testable
 * without a provider key, and keeps agent construction where the profiles are.
 *
 * ## Lifetime
 *
 * Session-scoped, not turn-scoped, for the same reason `BackgroundJobs` is: the
 * turn's `AbortSignal` fires when the turn ends, so an agent wired to it would
 * die exactly when it was supposed to keep working. Each job therefore gets its
 * own controller. The parent agent owns the decision to start and stop them; the
 * user can intervene through `/agents`.
 *
 * ## What `kill` does
 *
 * Aborts the job's controller, which `run` is expected to have handed to
 * `execute(brief, { signal })`. From @agentionai/agents 1.7.0-beta.0 that is a
 * real stop: the in-flight provider request is aborted, no further requests or
 * tools start, and the call rejects with an `AbortError`. The agent's tools were
 * built with the same signal, so anything already in flight fails too.
 *
 * The status is set *before* the abort, so the rejection that follows lands on a
 * job that is already `killed` and `settle` leaves it alone. That ordering is
 * what keeps a cancellation from being reported as a failure — and it still
 * covers the case where a run somehow completes anyway.
 */

/** Finished jobs kept for later inspection before the oldest are dropped. */
const MAX_RETAINED_FINISHED = 20;

/** Recent tool calls kept per job, so `agent_output` can say what it is doing. */
const MAX_ACTIVITY = 12;

/**
 * 15 min. An agent gets a ceiling for the same reason a background command does:
 * "runs forever" is a leak, and an agent leaks money as well as a process slot.
 *
 * Lower than the shell's 30 because the failure modes differ. A long command is
 * usually a real build; a long agent is usually a model going in circles, and
 * every lap costs another request.
 */
export const DEFAULT_AGENT_TIMEOUT_MS = 15 * 60_000;

export type AgentJobStatus = 'running' | 'done' | 'failed' | 'killed' | 'timed-out';

/** How much of the tool belt a spawned agent gets. An enum rather than a list of
 *  tool names: this is a consent question shown at the spawn gate, and "may read
 *  and edit, may not run commands" is answerable where an arbitrary subset is
 *  not. */
export type AgentToolset = 'readonly' | 'edit' | 'full';

export interface AgentJob {
  /** `agent1`, `agent2`, … — short because the model has to echo it back. */
  id: string;
  /** The instructions the parent gave it, as approved at the spawn gate. */
  brief: string;
  tier: Tier;
  toolset: AgentToolset;
  /** `provider/model`, for display and the log. */
  label: string;
  startedAt: number;
  status: AgentJobStatus;
  endedAt?: number;
  /** The agent's final message. Present once status is `done`. */
  result?: string;
  /** Why it failed. Present once status is `failed`. */
  error?: string;
}

export interface StartAgentJobOptions {
  brief: string;
  tier: Tier;
  toolset: AgentToolset;
  label: string;
  /** Ceiling for this one job. Defaults to `DEFAULT_AGENT_TIMEOUT_MS`. */
  timeoutMs?: number;
  /**
   * Does the work. Receives the job's own signal, which callers are expected to
   * thread into the agent's tool belt — that is what makes `kill` bite today.
   */
  run(ctx: { id: string; signal: AbortSignal }): Promise<string>;
}

export interface AgentJobs {
  start(options: StartAgentJobOptions): AgentJob;
  get(id: string): AgentJob | undefined;
  list(): AgentJob[];
  /**
   * The result, if it has finished and nobody has taken it yet, then cleared.
   *
   * Drained for the same reason shell output is: the completion report and a
   * polling `agent_output` would otherwise both put the whole result into the
   * parent's context, and an agent's final message is not small.
   */
  read(id: string): string | undefined;
  /** What the job has been doing lately, oldest first. Never drained. */
  activity(id: string): string[];
  /** Record a step. Called by whoever wired up the agent's tool listeners. */
  note(id: string, line: string): void;
  /** True if the job existed and was running. */
  kill(id: string): boolean;
  /** Stops everything. Call on session teardown and on `/clear`. */
  killAll(): void;
}

export interface AgentJobsOptions {
  /**
   * Fired when a job ends *on its own*, never for `kill`/`killAll` — the same
   * rule as `BackgroundJobs.onExit`, and for the same reason. In the engine this
   * wakes the parent agent, and being woken by a stop you asked for, or by every
   * agent dying at teardown, is noise at best.
   */
  onDone?(job: AgentJob): void;
}

interface JobRecord {
  job: AgentJob;
  controller: AbortController;
  activity: string[];
  timer: NodeJS.Timeout;
  /** Cleared by `read`. Separate from `job.result` so `list` can still show that
   *  a job succeeded after its result has been consumed. */
  unread?: string;
}

export function createAgentJobs(options: AgentJobsOptions = {}): AgentJobs {
  const records = new Map<string, JobRecord>();
  let counter = 0;

  /** Finished jobs retain their whole result; a long session that spawns many
   *  would otherwise grow without bound. Running jobs are never dropped. */
  const prune = () => {
    const finished = [...records.values()]
      .filter(r => r.job.status !== 'running')
      .sort((a, b) => (a.job.endedAt ?? 0) - (b.job.endedAt ?? 0));
    for (const rec of finished.slice(0, finished.length - MAX_RETAINED_FINISHED)) {
      records.delete(rec.job.id);
    }
  };

  /**
   * Ends a job the caller (or the clock) decided to stop, rather than one that
   * finished. Status first, then abort — see the note on `settle`.
   *
   * A timeout reports, a kill does not, which is the same split `BackgroundJobs`
   * draws: whoever asked for the stop already knows it stopped, but nobody asked
   * for the ceiling. An agent that hits it has left work unfinished, and the
   * parent is the only one who can decide what to do about that.
   */
  const stop = (rec: JobRecord, status: 'killed' | 'timed-out'): void => {
    if (rec.job.status !== 'running') return;
    clearTimeout(rec.timer);
    rec.job.status = status;
    rec.job.endedAt = Date.now();
    rec.controller.abort();
    if (status === 'timed-out') options.onDone?.({ ...rec.job });
  };

  const settle = (rec: JobRecord, outcome: { result: string } | { error: string }) => {
    // A killed job stays killed. Aborting makes `run` reject with an AbortError
    // moments later, and that rejection is the *consequence* of the kill, not a
    // failure worth reporting — so it must not overwrite the status, and must
    // not fire onDone. Same guard covers a run that completes despite the abort.
    if (rec.job.status !== 'running') return;
    clearTimeout(rec.timer);
    rec.job.status = 'result' in outcome ? 'done' : 'failed';
    rec.job.endedAt = Date.now();
    if ('result' in outcome) {
      rec.job.result = outcome.result;
      rec.unread = outcome.result;
    } else {
      rec.job.error = outcome.error;
    }
    prune();
    options.onDone?.({ ...rec.job });
  };

  return {
    start({ brief, tier, toolset, label, run, timeoutMs }) {
      const id = `agent${++counter}`;
      const job: AgentJob = {
        id,
        brief,
        tier,
        toolset,
        label,
        startedAt: Date.now(),
        status: 'running',
      };
      const rec: JobRecord = {
        job,
        controller: new AbortController(),
        activity: [],
        timer: setTimeout(
          () => stop(rec, 'timed-out'),
          timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
        ),
      };
      // Nothing should be held open purely by an agent's ceiling: on quit the
      // process must be free to exit once killAll has run.
      rec.timer.unref?.();
      records.set(id, rec);

      // Not awaited: that is the whole point. The rejection path is handled
      // here rather than left to the caller, so a thrown agent becomes a
      // `failed` job the parent can read rather than an unhandled rejection.
      void Promise.resolve()
        .then(() => run({ id, signal: rec.controller.signal }))
        .then(
          (result) => settle(rec, { result }),
          (err: unknown) => settle(rec, { error: err instanceof Error ? err.message : String(err) }),
        );

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
      const out = rec.unread;
      rec.unread = undefined;
      return out;
    },

    activity(id) {
      return [...(records.get(id)?.activity ?? [])];
    },

    note(id, line) {
      const rec = records.get(id);
      if (!rec || rec.job.status !== 'running') return;
      rec.activity.push(line);
      if (rec.activity.length > MAX_ACTIVITY) rec.activity.shift();
    },

    kill(id) {
      const rec = records.get(id);
      if (!rec || rec.job.status !== 'running') return false;
      stop(rec, 'killed');
      prune();
      return true;
    },

    killAll() {
      for (const rec of records.values()) stop(rec, 'killed');
      prune();
    },
  };
}

/** One line describing a job — shared by `agent_list`, `agent_output` and the
 *  completion report the engine feeds back into history. */
export function summariseAgentJob(job: AgentJob): string {
  const elapsed = ((job.endedAt ?? Date.now()) - job.startedAt) / 1000;
  const state = job.status === 'running'
    ? `running for ${elapsed.toFixed(1)}s`
    : `${job.status} after ${elapsed.toFixed(1)}s`;
  return `${job.id} (${job.tier}, ${job.label}, ${job.toolset}) — ${state}`;
}
