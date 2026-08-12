import { useMemo } from 'react';
import { formatTokens } from '@agentionai/marshall-engine';
import type { OutputEvent, ClientInterface, UsageTotals } from '@agentionai/marshall-engine';
import type { ApprovalRequest, ApprovalDecision, AskRequest } from '@agentionai/marshall-tools';
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
  /**
   * Token spend so far. Arrives repeatedly during a turn, each event carrying
   * the whole picture rather than a delta, so a client can render the latest
   * one and ignore the rest.
   */
  reportUsage?(usage: {
    turn: UsageTotals;
    session: UsageTotals;
    durationMs: number;
    final: boolean;
    /** Per-direction rates for the watched agent — see the `usage` event. */
    rates?: { input?: number; output?: number };
    /** Time to the turn's first token. */
    ttftMs?: number;
  }): void;
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
  askUser(request: AskRequest): Promise<string>;
}

/**
 * Translate engine output events into transcript operations.
 *
 * Pure: same events in, same port calls out. Exported separately from the hook
 * so tests can drive it directly.
 */
/** The opening of a multi-line value, for a row that has one line to give it. */
function firstLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

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

        case 'agent-done': {
          commitStep();
          // The brief, not a summary of what it did: it is what the user
          // approved, and the report itself goes to the model rather than here.
          //
          // One line of it, though. A brief is written for an agent to work
          // from, so it runs to paragraphs — dropped whole into a single-line
          // row it wraps, and the fixed columns beside it get squeezed until
          // "agent1" renders as "agen" above a stray "1".
          port.push('spawn', firstLine(event.brief, 72), {
            title: event.id,
            failed: event.status === 'failed',
            note: `${event.tier}  ${G.bullet}  ${(event.durationMs / 1000).toFixed(1)}s` +
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

        // The judge's verdict on the call just above it — pushed as its own row
        // rather than folded into the tool-call row, because it arrives after
        // that row already rendered (the decider runs inside the tool's
        // `execute`, well after `tool-call` fires) and 'approve' included: a
        // call the human was never asked about is exactly the one whose review
        // would otherwise be invisible.
        case 'safety-verdict':
          port.push('safety', event.reason, {
            title: formatToolName(event.toolName),
            note: event.model,
            safetyOutcome: event.outcome,
            ...(event.caller ? { caller: event.caller } : {}),
          });
          break;

        case 'subagent-done':
          port.push(
            'subagent',
            event.error ?? `${(event.chars / 1000).toFixed(1)}k chars`,
            {
              title: event.label,
              // What the delegation actually cost, next to what it returned.
              // A `context` call that reads 40k tokens to hand back 800 chars
              // is doing its job; one that reads 40k to hand back 40k is not,
              // and the two are indistinguishable without this.
              note: [
                `${(event.durationMs / 1000).toFixed(1)}s`,
                event.outputTokens === undefined
                  ? undefined
                  : `↑${formatTokens(event.inputTokens ?? 0)} ↓${formatTokens(event.outputTokens)}`,
              ].filter(Boolean).join(` ${G.bullet} `),
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

        // Ungated on purpose. This used to sit behind the `/tokens` toggle,
        // back when it pushed a transcript row that not everyone wanted; it now
        // feeds a status row that is always on screen, and a permanently
        // opt-out one just spends its space saying "metrics unavailable".
        case 'usage':
          port.reportUsage?.({
            turn: event.turn,
            session: event.session,
            durationMs: event.durationMs,
            final: event.final,
            rates: event.rates,
            ttftMs: event.ttftMs,
          });
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

    askUser(request: AskRequest): Promise<string> {
      return port.askUser(request);
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
