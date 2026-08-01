import type { ApprovalRequest, ApprovalDecision } from '@marshall/tools';

export type { ApprovalRequest, ApprovalDecision };

export type OutputEvent =
  | { type: 'thinking' }
  | { type: 'agent-start'; agentName: string }
  | { type: 'tool-call'; toolName: string; input: unknown }
  | { type: 'tool-result'; toolName: string; result: string }
  | { type: 'token'; text: string }
  | { type: 'reasoning'; text: string }
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
