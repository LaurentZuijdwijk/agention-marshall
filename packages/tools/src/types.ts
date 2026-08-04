import type { BackgroundJobs } from './primitives/background.js';

export type ApprovalDecision = 'approve' | 'deny' | 'always';

export interface DedupeCacheEntry {
  hash: string;
  lineCount: number;
}

export interface DedupeCache {
  get(path: string): DedupeCacheEntry | undefined;
  set(path: string, entry: DedupeCacheEntry): void;
  clear(): void;
}

export function createDedupeCache(): DedupeCache {
  const map = new Map<string, DedupeCacheEntry>();
  return {
    get: (p) => map.get(p),
    set: (p, e) => { map.set(p, e); },
    clear: () => map.clear(),
  };
}

/**
 * Who a tool belt belongs to.
 *
 * A belt is built per agent, so the agent that will call these tools is known
 * at construction time — which is the only place it *is* known: the underlying
 * Tool passes its caller to event listeners, not into the execute function
 * where the approval gate runs.
 */
export interface ToolCaller {
  /** The role behind the belt: `coder`, `plan`, `review`. */
  role: string;
  /** `provider/model` actually running that role. */
  model: string;
}

export interface ApprovalRequest {
  toolName: string;
  /** One-line summary shown in the approval prompt */
  description: string;
  /** Full detail: diff for file edits, command line for shell */
  detail: string;
  /** The agent whose action is waiting on the user. */
  caller?: ToolCaller;
}

export type ApprovalFn = (request: ApprovalRequest) => Promise<ApprovalDecision>;

export interface Limits {
  /** Max bytes for file reads. Default: 256 KiB */
  maxFileBytes?: number;
  /** Max bytes captured from shell stdout/stderr each. Default: 64 KiB */
  maxOutputBytes?: number;
  /** Shell command timeout in ms. Default: 120 s */
  timeoutMs?: number;
  /** Max grep results returned. Default: 200 */
  maxSearchResults?: number;
  /** Ceiling for a backgrounded shell command. Default: 30 min. Separate from
   *  `timeoutMs` because the two answer different questions: how long to block a
   *  turn, versus how long to let a detached process live. */
  backgroundTimeoutMs?: number;
}

export type CommandPolicy =
  | { mode: 'allowlist'; patterns: RegExp[] }
  | { mode: 'denylist'; patterns: RegExp[] }
  | { mode: 'none' };

export interface ToolConfig {
  workspaceRoot: string;
  approval: ApprovalFn;
  signal?: AbortSignal;
  commandPolicy?: CommandPolicy;
  limits?: Limits;
  /** Stamped onto every approval this belt raises. */
  caller?: ToolCaller;
  /**
   * Registry for backgrounded shell commands. Absent means `run_shell` has no
   * `background` option and the job tools don't exist.
   *
   * Injected rather than owned by the factory because its lifetime is the
   * *session*, not the task: `signal` is aborted at the end of every turn, and a
   * job wired to that would die exactly when it was supposed to keep running.
   * Whoever owns the session owns the registry — and is responsible for calling
   * `killAll()` when the session ends.
   */
  jobs?: BackgroundJobs;
}

/** Plain tool spec — used by withApproval so it doesn't need Tool internals */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<string>;
}
