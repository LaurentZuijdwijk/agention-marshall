// ── render tracing (opt-in debug aid) ─────────────────────────────────────────
//
// Set MARSHALL_TRACE_RENDER=1 to record every component render to
// /tmp/marshall-render.log.
//
// Writes are synchronous on purpose. The failure we're chasing wedges the event
// loop, so anything async — a timer, a stream flush, a signal handler — never
// runs. appendFileSync still lands, which makes this the only instrument that
// reports from inside a frozen render loop.
//
// Self-limiting: it stops after MAX_ENTRIES so a runaway loop can't fill the
// disk, which is plenty to show which component is spinning and how fast.

import { appendFileSync } from 'node:fs';

const ENABLED = process.env.MARSHALL_TRACE_RENDER === '1';
const PATH = process.env.MARSHALL_TRACE_FILE ?? '/tmp/marshall-render.log';
const MAX_ENTRIES = 2000;

let written = 0;
const counts = new Map<string, number>();

/** Call at the top of a component body. No-op unless tracing is enabled. */
export function traceRender(component: string, detail?: string): void {
  if (!ENABLED || written >= MAX_ENTRIES) return;
  written++;
  const n = (counts.get(component) ?? 0) + 1;
  counts.set(component, n);
  try {
    appendFileSync(
      PATH,
      `${Date.now()} ${component} #${n}${detail ? ' ' + detail : ''}\n`,
    );
  } catch {
    // Tracing must never take the app down.
  }
}

export const tracingEnabled = ENABLED;
