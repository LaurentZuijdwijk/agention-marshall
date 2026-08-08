import { useMemo } from 'react';
import type { OutputEvent, ClientInterface } from '@agentionai/marshall-engine';
import type { ApprovalRequest, ApprovalDecision } from '@agentionai/marshall-tools';
import { formatToolInput, formatToolName } from '../format.js';
import { G } from '../view/theme.js';
import type { Message, MessageRole } from '../view/message.js';

/** How a turn finished — the caller decides what that means for its own mode. */
export type TurnOutcome = 'done' | 'error' | 'interrupted';

/**
 * Everything the translator below needs from the transcript.
 *
 * Deliberately behavioural rather than stateful: no setters, no React types, no
 * `Mode`. The translator says *what happened*; the caller decides what that does
 * to its state. That is what keeps `createEngineClient` a pure function and lets
 * it be tested without React or Ink.
 */
export interface TranscriptPort {
  push(role: MessageRole, content: string, extra?: Partial<Message>): void;
  /** Append a streamed token. Implementations drop it when streaming is off. */
  appendToken(text: string): void;
  /** Append reasoning. Implementations drop it when reasoning display is off. */
  appendReasoning(text: string): void;
  /** Return whatever has streamed so far and clear it in one step. */
  takeStream(): string;
  /** Return any pending reasoning and clear it in one step. */
  takeReasoning(): string;
  /**
   * A turn has begun. Almost always redundant — the caller started it and has
   * already switched its own UI — but a turn woken by a finished background job
   * has no such caller, and without this the transcript streams underneath an
   * input prompt that still looks ready for typing.
   */
  turnStarted(): void;
  turnEnded(outcome: TurnOutcome): void;
  reportUsage?(inputTokens: number, outputTokens: number, durationMs: number): void;
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
  showUsage(): boolean;
}

/**
 * Translate engine output events into transcript operations.
 *
 * Pure: same events in, same port calls out. Exported separately from the hook
 * so tests can drive it directly.
 */
export function createEngineClient(port: TranscriptPort): ClientInterface {
  /** Commit pending reasoning as its own row, in front of whatever follows. */
  const commitReasoning = () => {
    const reasoning = port.takeReasoning();
    if (reasoning.trim()) port.push('reasoning', reasoning);
  };

  /**
   * Close off the step the model just finished: its reasoning, then its prose,
   * each as one committed row.
   *
   * This is what keeps a multi-step turn in chronological order. The live
   * buffers only ever hold the *current* step — without this they accumulated
   * every step's text until the turn ended, so each tool row printed above prose
   * that had already been written, and the growing buffer redrew that same prose
   * again under every new row.
   */
  const commitStep = () => {
    commitReasoning();
    const text = port.takeStream();
    if (text.trim()) port.push('assistant', text);
  };

  return {
    onOutput(event: OutputEvent) {
      switch (event.type) {
        case 'thinking':
          port.turnStarted();
          break;

        case 'model-loading':
          commitStep();
          port.push('info', 'Loading model');
          break;

        case 'mcp-state': {
          // Only failures are surfaced unprompted. A server connecting normally
          // is not news, and printing a block per server at every startup would
          // bury the thing the user actually typed. `/mcp` shows the full list.
          const failed = event.servers.filter(s => s.status === 'error');
          if (failed.length === 0) break;
          commitStep();
          for (const server of failed) {
            port.push('error', `MCP server "${server.name}" is unavailable: ${server.error ?? 'could not connect'}`);
          }
          break;
        }

        case 'job-done': {
          const failed = event.status === 'timed-out' || event.exitCode !== 0;
          const outcome = event.status === 'timed-out'
            ? 'timed out'
            : `exit ${event.exitCode ?? '?'}`;
          // Whatever the model was mid-sentence on stays above the completion,
          // which can land in the middle of an unrelated turn.
          commitStep();
          port.push('job', event.command, {
            title: event.id,
            failed,
            note: `${outcome}  ${G.bullet}  ${(event.durationMs / 1000).toFixed(1)}s` +
              (event.resuming ? `  ${G.bullet}  picking it up` : ''),
          });
          break;
        }

        case 'tool-call':
          // Nested calls flush too: their buffers are empty (only the main agent
          // streams), so this costs nothing and needs no special case.
          commitStep();
          // An agent-backed tool is a delegation, not a file read, and gets its
          // own presentation — this is the thing that makes the multi-agent loop
          // legible rather than something you have to take on faith.
          port.push(event.subagent ? 'agent' : 'tool', formatToolInput(event.input), {
            title: formatToolName(event.toolName),
            ...(event.subagent ? { note: event.subagent.model, delegated: event.subagent.delegated } : {}),
            ...(event.parent ? { parent: event.parent } : {}),
            ...(event.caller ? { caller: event.caller } : {}),
          });
          break;

        case 'tool-result':
          // A sub-agent's raw results would drown the transcript — its *calls*
          // already show what it is doing, and its findings arrive in the
          // summary it returns.
          if (event.parent) break;
          port.push('tool-result', event.result);
          break;

        case 'subagent-done':
          port.push(
            'subagent',
            event.error ?? `${(event.chars / 1000).toFixed(1)}k chars`,
            {
              title: event.label,
              note: `${(event.durationMs / 1000).toFixed(1)}s`,
              failed: event.error !== undefined,
            },
          );
          break;

        case 'token':
          port.appendToken(event.text);
          break;

        case 'reasoning':
          port.appendReasoning(event.text);
          break;

        case 'assistant': {
          // Mid-turn prose from a provider that doesn't stream. Its reasoning
          // goes above it; the stream buffer is dropped rather than committed,
          // because a provider that sends both is sending the same text twice.
          commitReasoning();
          port.takeStream();
          if (event.text.trim()) port.push('assistant', event.text);
          break;
        }

        case 'response': {
          // The event carries the final answer in full, and the stream buffer
          // holds that same text arriving token by token — commit one of them,
          // never both. Reasoning goes first, the order the model produced it in.
          const streamed = port.takeStream();
          commitReasoning();
          const text = event.text.trim() ? event.text : streamed;
          if (text.trim()) port.push('assistant', text);
          port.turnEnded('done');
          break;
        }

        case 'usage':
          if (port.showUsage()) {
            port.reportUsage?.(event.inputTokens, event.outputTokens, event.durationMs);
          }
          break;

        case 'error':
          // Whatever the model had already said stays above the failure rather
          // than vanishing with it.
          commitStep();
          port.push('error', event.message);
          port.turnEnded('error');
          break;

        case 'interrupted':
          // The partial answer was on screen when Esc was pressed; committing it
          // means the transcript matches what the user saw and acted on.
          commitStep();
          port.push('info', 'interrupted — steer with a new instruction, or /clear to reset');
          port.turnEnded('interrupted');
          break;

        case 'context-full':
          commitStep();
          port.push('info', event.compressed
            ? 'context window full — compressed the conversation; continue with a new message, or /clear to reset'
            : 'context window full and could not be compressed automatically — try a shorter request, or /clear to reset');
          port.turnEnded('interrupted');
          break;

        case 'plan':
          port.push('markdown', event.text, {
            title: 'plan',
            note: 'will be used as context for your next task',
          });
          port.turnEnded('done');
          break;

        case 'goal':
          port.push('markdown', event.text, {
            title: 'goal',
            note: 'will be used as context for your next task',
          });
          port.turnEnded('done');
          break;

        case 'review':
          port.push('markdown', event.text, { title: 'review' });
          port.turnEnded('done');
          break;
      }
    },

    requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
      return port.requestApproval(request);
    },
  };
}

/**
 * The client identity must be stable — the engine Session holds onto it — so the
 * port is expected to read through refs rather than close over render values.
 */
export function useEngineClient(port: TranscriptPort): ClientInterface {
  return useMemo(() => createEngineClient(port), []); // eslint-disable-line react-hooks/exhaustive-deps
}
