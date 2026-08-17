// ── HTTP tracing (opt-in debug aid) ─────────────────────────────────────────────
//
// `OPENAI_LOG=debug` is the `openai` SDK's own switch — every provider that
// isn't Claude goes through it (llama.cpp, Ollama, OpenRouter, OpenAI itself),
// and at that level it logs the exact outgoing request (method, url, headers,
// body) and the response for each one, with `authorization`/`api-key`/`cookie`
// headers already redacted by the SDK before it ever reaches here.
//
// Left alone, that lands on `console.debug`, which is `process.stdout` — the
// same stream Ink owns for the whole screen, so the very first line would
// scramble the UI rather than inform anyone. This redirects `console.debug`
// and `console.info` to a file instead, only when the env var opts in, so the
// default run pays nothing and prints nothing.
//
// The redirect is global, not scoped to the SDK: `console.info`/`console.debug`
// calls from anywhere else in the process (other libraries' own logging, Ink's
// own warnings) land in the same http.log rather than the terminal for as long
// as OPENAI_LOG is set. That is deliberate, not incidental — the same Ink
// constraint that makes the SDK's own debug output unsafe to print applies to
// any stray console.debug/info from anywhere, so silencing only the SDK's own
// calls would still let another module's console.info corrupt the screen.
// There is no per-call-site way to tell them apart once `console.info` has
// been reassigned, so if that ever matters, the fix is elsewhere: passing a
// scoped `logger` into whichever client construction accepts one, not
// narrowing this redirect.

import { dirname, join } from 'node:path';
import { mkdirSync, appendFileSync } from 'node:fs';

export function installHttpTrace(workspaceRoot: string): void {
  if (!process.env.OPENAI_LOG) return;

  const logPath = join(workspaceRoot, '.marshall', 'logs', 'http.log');
  try {
    mkdirSync(dirname(logPath), { recursive: true });
  } catch {
    return; // no writable log dir — leave console.debug alone rather than throw
  }

  const render = (arg: unknown): string => {
    if (typeof arg === 'string') return arg;
    // A circular reference or a BigInt makes JSON.stringify throw — this is a
    // best-effort trace file, so fall back to a plain string rather than let
    // that escape into the caller (some other library's own console.info
    // call, once this redirect is installed).
    try { return JSON.stringify(arg, null, 2); } catch { return String(arg); }
  };

  const toFile = (...args: unknown[]) => {
    const line = `[${new Date().toISOString()}] ${args.map(render).join(' ')}\n`;
    try { appendFileSync(logPath, line); } catch { /* tracing must never crash the session */ }
  };
  // The SDK logs the one-line "succeeded/failed with status" summary at `info`
  // and the full request/response dump at `debug` — both fire once `OPENAI_LOG`
  // is `debug` (the levels are cumulative), so both need redirecting or the
  // summary line alone still reaches the terminal and scrambles the UI.
  console.debug = toFile;
  console.info = toFile;
}
