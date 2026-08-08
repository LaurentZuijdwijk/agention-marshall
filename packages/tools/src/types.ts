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
  /**
   * Which *instance* of that role, when a role can have several live at once.
   *
   * Absent for roles that are singular by construction, like the coder. Present
   * once work is fanned out, where the role name alone stops identifying anyone:
   * two agents on the same role and model are the same string, and a consent
   * gate that cannot tell them apart will let one agent's approval answer for
   * another's action. Sub-agent spawns already name themselves this way for the
   * transcript (`context#0`); this carries the same identity to the gate.
   */
  id?: string;
}

/**
 * Where a tool came from.
 *
 * Carried on every approval request because provenance is the strongest risk
 * signal available: `write_file` is code we audited, while an MCP tool is a
 * remote party's code whose name and description it also controls. The
 * approval UI shows it, and it is the first thing an automated reviewer would
 * weigh — see ApprovalDecider.
 */
export type ToolSource =
  | { kind: 'builtin' }
  | {
      kind: 'mcp';
      /** The local name for the server, as configured. */
      server: string;
      /** The tool's name on the server, before namespacing. */
      remoteName: string;
    };

export interface AskRequest {
  question: string;
  options?: string[];
  multiSelect?: boolean;
  allowFreeText?: boolean;
}

export type AskFn = (request: AskRequest) => Promise<string>;

export interface ApprovalRequest {
  toolName: string;
  /** One-line summary shown in the approval prompt */
  description: string;
  /** Full detail: diff for file edits, command line for shell */
  detail: string;
  /** The agent whose action is waiting on the user. */
  caller?: ToolCaller;
  /**
   * The raw arguments the tool was called with.
   *
   * Alongside `detail` rather than replacing it: `detail` is prose for a human
   * to read, this is structure for a program to judge. An automated reviewer
   * cannot reliably work backwards from a rendered diff.
   */
  input?: Record<string, unknown>;
  /** Defaults to builtin when absent. */
  source?: ToolSource;
  /**
   * The user's current instruction, verbatim — what the caller is actually
   * trying to accomplish this turn.
   *
   * Without this, an automated reviewer (or a human glancing at a bare
   * command) has no way to tell "the user asked me to delete this file" apart
   * from "the agent decided to delete this file on its own" — the two produce
   * an identical tool call. It is what lets a reviewer judge *scope*, not just
   * the action in isolation.
   */
  taskContext?: string;
}

export type ApprovalFn = (request: ApprovalRequest) => Promise<ApprovalDecision>;

/**
 * One link in the chain that answers an approval request.
 *
 * `'defer'` means "no opinion, ask the next one" — the outcome a three-valued
 * ApprovalDecision cannot express, and the reason this type exists separately.
 * The chain today is [session always-allow list, the human]; the point of the
 * seam is that an agent that judges a request and only escalates the risky ones
 * becomes an entry inserted before the human, with no tool changing.
 */
export type ApprovalDecider = (request: ApprovalRequest) => Promise<ApprovalDecision | 'defer'>;

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
  /** Stamped onto every approval this belt raises, as `ApprovalRequest.taskContext`.
   *  The session's job to keep current — a belt built once per turn gets it
   *  fresh each time, the same way `caller` is already per-belt, not per-tool. */
  taskContext?: string;
  /**
   * Files `read_file` has seen, which `write_file` and `edit_file` require
   * before they will touch an existing file.
   *
   * Injected for the same reason as `jobs` below: its lifetime is the
   * *session*, not the task. The belt is rebuilt every turn, so a set owned by
   * the factory silently resets between turns — the model reads a file, the
   * turn ends, and editing it in the next turn fails with "has not been read
   * this session" even though it was. Absent means per-belt tracking, which is
   * what the sub-agent belts and the tests want.
   *
   * Maps path to a hash of the content as the caller last saw it, so
   * `write_file` can refuse an overwrite built from a stale view rather than
   * silently discarding whatever landed in between.
   */
  readFiles?: Map<string, string>;
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
