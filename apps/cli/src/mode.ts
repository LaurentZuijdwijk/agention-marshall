// ── what the app is doing right now ───────────────────────────────────────────
//
// One discriminated union rather than a handful of booleans: `running` and
// `approval` and `setup` are mutually exclusive, and the states that carry data
// (the pending approval, the login in flight) carry it with them.

import type { Tier } from '@agentionai/marshall-engine';
import type { ApprovalRequest, AskRequest } from '@agentionai/marshall-tools';
import type { LoginSession } from './login.js';

export type Mode =
  // `chain` continues on to the fast tier once deep is chosen — that's the
  // first-run flow. `/model fast` sets just one tier and stops.
  | { type: 'setup'; tier: Tier; chain: boolean }
  /** The root `/setup` settings category menu. */
  | { type: 'settings-menu'; scope: 'project' | 'global' }
  | { type: 'idle' }
  | { type: 'running' }
  | { type: 'login-pending'; session: LoginSession }
  | { type: 'approval'; request: ApprovalRequest }
  | { type: 'question'; request: AskRequest }
  /** The `/mcp add` wizard, asking for url, name and token. */
  | { type: 'mcp-setup' }
  /** `/safety agentic` — picking the model that reviews tool calls. */
  | { type: 'safety-setup' };

export type SetMode = (mode: Mode) => void;
