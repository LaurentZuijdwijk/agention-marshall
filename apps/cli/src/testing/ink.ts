// ── driving Ink from a test ───────────────────────────────────────────────────
//
// Shared by the App unit tests and the integration suite, because getting these
// two streams wrong fails silently rather than loudly:
//
//   * Ink only renders incrementally in interactive mode. Against a plain
//     Writable it writes nothing until unmount — so every assertion runs against
//     an empty buffer, and the negative ones ("does not show the wizard") pass
//     for the wrong reason. A TTY-shaped stdout is necessary but *not* enough:
//     see `renderTui` for the half that only bites on CI.
//   * useInput needs raw mode. A bare Readable has neither `isTTY` nor
//     `setRawMode`, so Ink renders "Raw mode is not supported" instead of the app.
//
// Render through `renderTui` rather than Ink's `render` directly, so a new test
// cannot miss either half.

import { Readable, Writable } from 'node:stream';
import type { ReactElement } from 'react';
import { render, type Instance, type RenderOptions } from 'ink';

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

export type RenderTuiOptions = Omit<RenderOptions, 'stdout' | 'stdin'> & {
  stdout: FakeStdout;
  stdin?: FakeStdin;
};

/**
 * Render into the fake streams with the options every test needs.
 *
 * `interactive: true` is the load-bearing one. Ink resolves interactive as
 * `!isInCi && stdout.isTTY`, and `is-in-ci` snapshots `process.env.CI` at module
 * load — so on GitHub Actions a TTY-shaped stdout is still non-interactive, and
 * Ink writes only the <Static> transcript, holding the dynamic frame back until
 * unmount. Waiting on anything in that frame (the idle prompt, the wizard, live
 * output) then times out: green locally, red on CI, for every test that types.
 * Clearing CI in a beforeEach is too late to help — is-in-ci has already read it
 * — so the option is the only reliable override.
 */
export function renderTui(node: ReactElement, options: RenderTuiOptions): Instance {
  const { stdout, stdin = fakeStdin(), ...rest } = options;
  return render(node, {
    interactive: true,
    patchConsole: false,
    exitOnCtrlC: false,
    // After the defaults, so a test that needs one of them back can say so.
    ...rest,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
  });
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
