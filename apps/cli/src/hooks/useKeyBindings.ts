import { useRef } from 'react';
import { useInput } from 'ink';
import type { Mode } from '../mode.js';

export interface KeyBindings {
  mode: Mode;
  /** Whether there is a slash-command completion to accept. */
  hasCompletion: boolean;
  acceptCompletion(): void;
  toggleReasoning(): void;
  /** Ctrl-V while the prompt is accepting input: attach the clipboard image. */
  attachImage(): void;
  quit(): void;
  /** Esc while work is in flight. */
  interrupt(): void;
  /** Esc while an approval is on screen: deny everything queued, then interrupt. */
  interruptApproval(): void;
}

/** Two presses inside this window mean "quit", not "interrupt". */
const DOUBLE_TAP_MS = 500;

/**
 * Every global key the app answers to.
 *
 * Kept in one place because these handlers interact: the quit double-tap has to
 * know that Esc means something else inside the wizard, and that a bare Ctrl-C
 * when nothing is running is a quit rather than an interrupt.
 */
export function useKeyBindings(bindings: KeyBindings): void {
  const { mode } = bindings;

  useInput((_, key) => {
    // TextInput snaps its cursor to the end of the new value — no remount.
    if (key.tab && bindings.hasCompletion && mode.type === 'idle') bindings.acceptCompletion();
  });

  // Ctrl-R toggles live chain-of-thought (providers that stream it —
  // OpenRouter thinking models; silent no-op elsewhere).
  useInput((input, key) => {
    if (key.ctrl && input === 'r') bindings.toggleReasoning();
  });

  // Ctrl-V reads the image off the system clipboard. It is a separate key from
  // paste because the terminal cannot deliver one: bracketed paste carries
  // characters, so image bytes never reach stdin at all. Idle only — attaching
  // to a prompt that is not accepting input would go nowhere.
  useInput((input, key) => {
    if (key.ctrl && input === 'v' && mode.type === 'idle') bindings.attachImage();
  });

  // ── interrupt / quit ───────────────────────────────────────────────────────
  //
  // Esc and Ctrl-C share one handler. While work is in flight the first press
  // interrupts; a second press within the double-tap window quits outright, so
  // a wedged task can never trap the user.
  const lastQuitKey = useRef(0);

  useInput((input, key) => {
    const isEsc = key.escape;
    const isCtrlC = key.ctrl && input === 'c';
    if (!isEsc && !isCtrlC) return;

    // In the wizard Esc means "go back" — let Setup handle it. It must not
    // count toward the quit double-tap either: terminals that split an
    // arrow-key escape sequence deliver a bare ESC first, so navigating the
    // model list with ↑↓ would otherwise read as Esc Esc and kill the session.
    // Ctrl-C has nothing to interrupt here, so it quits straight away.
    if (mode.type === 'setup') {
      if (isCtrlC) bindings.quit();
      return;
    }

    const now = Date.now();
    const doubleTapped = now - lastQuitKey.current < DOUBLE_TAP_MS;
    lastQuitKey.current = now;

    if (doubleTapped)              { bindings.quit(); return; }
    if (mode.type === 'running')   { bindings.interrupt(); return; }
    if (mode.type === 'approval')  { bindings.interruptApproval(); return; }

    // Idle: Esc is a no-op (double-tap quits), but a lone Ctrl-C means the
    // user wants out and there is nothing running to protect.
    if (isCtrlC) bindings.quit();
  });
}
