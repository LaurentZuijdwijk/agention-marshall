import type { ApprovalRequest, ApprovalDecision } from '@agentionai/marshall-tools';

export type { ApprovalRequest, ApprovalDecision };

export type OutputEvent =
  | { type: 'thinking' }
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
  | { type: 'plan'; text: string }
  | { type: 'review'; text: string };

export interface ClientInterface {
  onOutput(event: OutputEvent): void;
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
  getEditorContext?(): EditorContext | null;
}

export interface EditorContext {
  openFiles: string[];
  activeFile?: string;
  selection?: { startLine: number; endLine: number };
  diagnostics?: Array<{ file: string; line: number; message: string }>;
}
