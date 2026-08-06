// ── driving Ink from a test ───────────────────────────────────────────────────
//
// Shared by the App unit tests and the integration suite, because getting these
// two streams wrong fails silently rather than loudly:
//
//   * Ink only renders incrementally when stdout looks like a TTY. Against a
//     plain Writable it stays in non-interactive mode and writes nothing until
//     unmount — so every assertion runs against an empty buffer, and the
//     negative ones ("does not show the wizard") pass for the wrong reason.
//   * useInput needs raw mode. A bare Readable has neither `isTTY` nor
//     `setRawMode`, so Ink renders "Raw mode is not supported" instead of the app.

import { Readable, Writable } from 'node:stream';

export type FakeStdout = Writable & { isTTY: boolean; columns: number; rows: number };
export type FakeStdin = Readable & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => void;
  ref: () => void;
  unref: () => void;
};

/** A TTY-shaped stdout that hands every frame to `sink`. */
export function fakeStdout(sink: (chunk: string) => void, columns = 100, rows = 30): FakeStdout {
  const stdout = new Writable({
    write(chunk, _encoding, cb) { sink(chunk.toString()); cb(); },
  }) as FakeStdout;
  stdout.isTTY = true;
  stdout.columns = columns;
  stdout.rows = rows;
  return stdout;
}

/** A TTY-shaped stdin. `push()` on the result delivers keystrokes to the app. */
export function fakeStdin(): FakeStdin {
  const stdin = new Readable({ read() {} }) as FakeStdin;
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  return stdin;
}

/**
 * Poll until `predicate` holds, so tests wait on the rendered frame rather than
 * a guessed number of ticks. Throws on timeout with `what` in the message —
 * a bare `waitFor` that gives up quietly turns into an assertion failure three
 * lines later that says nothing about the real cause.
 */
export async function waitFor(
  predicate: () => boolean,
  what = 'condition',
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/** Keystrokes that are awkward to write inline. */
export const KEY = {
  enter: '\r',
  escape: '\u001B',
  ctrlC: '\u0003',
  ctrlV: '\u0016',
  up: '\u001B[A',
  down: '\u001B[B',
} as const;
