import type { ApprovalRequest, ApprovalDecision, AskRequest } from '@agentionai/marshall-tools';
import type { McpServerState } from './mcp.js';

export type { ApprovalRequest, ApprovalDecision, AskRequest };

export type OutputEvent =
  | { type: 'thinking' }
  /** Emitted before a local llama.cpp agent is created, while its model loads. */
  | { type: 'model-loading' }
  | { type: 'agent-start'; agentName: string }
  /** `subagent` is set when the "tool" is really another agent — the client
   *  should present it as a delegation, not as a file read. `delegated` marks
   *  the case where that agent runs on a different model than the deep tier.
   *
   *  `parent` is set on activity *inside* a sub-agent (e.g. the `read_file` a
   *  `context` agent runs), carrying the owning call's label like `context#0`.
   *  Without it a delegated survey is a silent gap in the transcript, and with
   *  fan-out several agents interleave with no way to tell them apart.
   *
   *  `caller` names the agent that made the call when it isn't the coder — the
   *  /plan and /review agents read files of their own, and those rows are
   *  otherwise indistinguishable from the coder's. */
  | {
      type: 'tool-call';
      toolName: string;
      input: unknown;
      subagent?: { model: string; delegated: boolean };
      parent?: string;
      caller?: string;
    }
  | { type: 'tool-result'; toolName: string; result: string; parent?: string }
  /** A sub-agent invocation finished. */
  | { type: 'subagent-done'; label: string; durationMs: number; chars: number; error?: string }
  /**
   * A backgrounded shell command ended on its own. Unlike every other event
   * here, this one can arrive while no turn is running — it is the one thing the
   * engine reports without having been asked.
   *
   * `resuming` says what happens next: true means the engine is starting a turn
   * to act on the result, false means it is queued for the user's next message.
   * The client needs the distinction to know whether to show a prompt or a
   * spinner.
   */
  | {
      type: 'job-done';
      id: string;
      command: string;
      status: 'exited' | 'timed-out';
      exitCode: number | null;
      durationMs: number;
      resuming: boolean;
    }
  | { type: 'token'; text: string }
  | { type: 'reasoning'; text: string }
  /** Prose the model produced *before* the tool calls of the same step — the
   *  "I'll read the config first" that belongs above those calls rather than
   *  folded into the final answer. Only providers that hand back the whole
   *  message (Claude) can send it; streaming ones deliver the same text as
   *  `token` events, so a client that commits its stream buffer at each tool
   *  call gets the identical row either way. */
  | { type: 'assistant'; text: string }
  /** The turn's final answer. */
  | { type: 'response'; text: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; durationMs: number }
  | { type: 'error'; message: string }
  | { type: 'interrupted' }
  /**
   * The model's context window filled up mid-turn and the task was abandoned
   * rather than retried — our own token estimate is unreliable enough for
   * code-heavy content that a blind retry is a gamble, so recovery stops
   * after one compression pass instead. `compressed` says whether that pass
   * actually freed anything; either way the task is queued as steering
   * context (like an Esc-interrupt), so the user's next message picks up
   * where this one left off. */
  | { type: 'context-full'; compressed: boolean }
  | { type: 'plan'; text: string }
  /** Same idea as `plan`, but the sub-agent was asked for the destination
   *  (success criteria, what "done" means) rather than the route. */
  | { type: 'goal'; text: string }
  | { type: 'review'; text: string }
  /**
   * The full picture of every configured MCP server, pushed on each change.
   *
   * Whole-state rather than per-server deltas: there are a handful of servers at
   * most, and a client that renders a list from the latest snapshot cannot drift
   * out of sync the way one accumulating events can. Like `job-done`, this can
   * arrive with no turn running — the initial connect settles on its own. */
  | { type: 'mcp-state'; servers: McpServerState[] };

export interface ClientInterface {
  onOutput(event: OutputEvent): void;
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
  askUser?(request: AskRequest): Promise<string>;
  getEditorContext?(): EditorContext | null;
}

export interface EditorContext {
  openFiles: string[];
  activeFile?: string;
  selection?: { startLine: number; endLine: number };
  diagnostics?: Array<{ file: string; line: number; message: string }>;
}
