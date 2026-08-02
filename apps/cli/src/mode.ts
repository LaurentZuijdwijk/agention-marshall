// ── what the app is doing right now ───────────────────────────────────────────
//
// One discriminated union rather than a handful of booleans: `running` and
// `approval` and `setup` are mutually exclusive, and the states that carry data
// (the pending approval, the login in flight) carry it with them.

import type { Tier } from '@agentionai/marshall-engine';
import type { ApprovalRequest } from '@agentionai/marshall-tools';
import type { LoginSession } from './login.js';

export type Mode =
  // `chain` continues on to the fast tier once deep is chosen — that's the
  // first-run flow. `/model fast` sets just one tier and stops.
  | { type: 'setup'; tier: Tier; chain: boolean }
  | { type: 'idle' }
  | { type: 'running' }
  | { type: 'login-pending'; session: LoginSession }
  | { type: 'approval'; request: ApprovalRequest };

export type SetMode = (mode: Mode) => void;
