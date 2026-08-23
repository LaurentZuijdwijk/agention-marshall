// ── background failures ───────────────────────────────────────────────────────
//
// A background rejection must not take the TUI down with it. The agent SDK has
// fire-and-forget paths (compressionPlugin's `void history.reduce(...)`), and a
// provider going away mid-flight surfaced there as an unhandled rejection —
// Node's default is to rethrow, which killed the session and everything in it.
//
// Log to the session file and keep running; the user can retry or /clear.

import { dirname, join } from 'node:path';
import { mkdirSync, appendFileSync } from 'node:fs';

export function installCrashLogging(workspaceRoot: string, privateMode?: boolean): void {
  const logPath = join(workspaceRoot, '.marshall', 'logs', 'session.log');

  const note = (kind: string, err: unknown) => {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    // Private mode still needs to keep the process alive — that's the whole
    // point of this file — it just can't write the error (which may quote
    // the prompt) to disk. stderr instead of dropping it silently: still
    // visible to whoever is running the session, never persisted.
    if (privateMode) {
      console.error(`[${new Date().toISOString()}] ${kind} ${message}`);
      return;
    }
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, `[${new Date().toISOString()}] ${kind} ${message}\n`);
    } catch { /* logging must never be the thing that crashes us */ }
  };

  process.on('unhandledRejection', reason => note('UNHANDLED_REJECTION', reason));
  process.on('uncaughtException', err => note('UNCAUGHT_EXCEPTION', err));
}
