import type { ApprovalRequest, ApprovalDecision, AskRequest } from '@agentionai/marshall-tools';
import type { McpServerState } from './mcp.js';
import type { UsageTotals } from './usage.js';

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
  /**
   * Safety level 3's judge model reached a verdict on the call it was just
   * emitted alongside — `outcome: 'approve'` included, since a call the human
   * never saw approved is exactly the one whose review a client would
   * otherwise have no way to show. `reason` is a single summarised line, not
   * the model's full raw response — see `summarizeReason` in safety-agent.ts. */
  | {
      type: 'safety-verdict';
      toolName: string;
      outcome: 'approve' | 'deny' | 'unclear';
      reason: string;
      model: string;
      caller?: string;
    }
  /** A sub-agent invocation finished. */
  | {
      type: 'subagent-done';
      label: string;
      durationMs: number;
      chars: number;
      error?: string;
      /** What this one call spent, when its provider reports usage. */
      inputTokens?: number;
      outputTokens?: number;
    }
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
  /**
   * A spawned agent finished on its own. The second event that can arrive with
   * no turn running, and for the same reason as `job-done`: the parent started
   * something that outlives the reply which started it.
   *
   * Carries the `brief` rather than a summary of the work, because the brief is
   * what the user approved at the spawn gate — a client that shows what finished
   * should show the thing that was consented to, not a paraphrase of it.
   */
  | {
      type: 'agent-done';
      id: string;
      brief: string;
      /** Absent when spawned by `agentName` instead of a bare tier. */
      tier?: 'deep' | 'fast';
      /** Set when spawned via a saved named agent instead of a bare tier. */
      agentName?: string;
      /** `provider/model` it ran on. */
      model: string;
      status: 'done' | 'failed' | 'timed-out';
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
  /**
   * Token spend, sampled while the turn runs and once more when it ends.
   *
   * `turn` and `session` already include every sub-agent the turn fanned out to.
   * That rollup is the point: the coder's own counter is the only figure a
   * provider returns, and it makes a turn that spent most of its tokens inside
   * three parallel `context` calls look nearly free.
   *
   * `final` marks the reading taken once the turn is over. The samples before it
   * are real provider numbers too, just incomplete — the last one lands after
   * the answer, so a client that only trusts `final` still gets an exact total.
   */
  | {
      type: 'usage';
      durationMs: number;
      turn: UsageTotals;
      session: UsageTotals;
      final: boolean;
      /**
       * Tokens per second — see `throughputOf` for which of these can be
       * trusted when, and why `input` goes missing on a model that thinks
       * without streaming it.
       *
       * Describes only the agent whose stream is being watched, and its own
       * token counts, unlike `turn`. Sub-agents run in parallel on other models
       * and other clocks, so there is no wall-clock they and the coder share
       * that a rate could honestly be taken over.
       */
      rates?: { input?: number; output?: number };
      /** Time to the turn's first token. Absent until one arrives. */
      ttftMs?: number;
    }
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
