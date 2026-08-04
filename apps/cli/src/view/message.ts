// ── the transcript row model ──────────────────────────────────────────────────
//
// Shared between the state that owns the transcript and the components that
// render it, so neither side has to import the other.

import type { HeaderMeta } from './Banner.js';

export type MessageRole =
  | 'header' | 'user' | 'assistant' | 'markdown' | 'tool' | 'tool-result'
  | 'info' | 'usage' | 'error' | 'reasoning' | 'agent' | 'subagent' | 'job';

export interface Message {
  key: string;
  role: MessageRole;
  content: string;
  /** Header rows carry the session summary instead of text. */
  meta?: HeaderMeta;
  /** Tool name, or the heading above a markdown block. */
  title?: string;
  /** Dim aside next to the title. */
  note?: string;
  /** Set on activity inside a sub-agent — renders indented under its caller. */
  parent?: string;
  /** The agent that made this call, when it isn't the coder (`plan`, `review`). */
  caller?: string;
  /** Agent rows: true when it runs on a different model than the deep tier. */
  delegated?: boolean;
  /** Sub-agent completion rows: the invocation ended in an error. */
  failed?: boolean;
}
