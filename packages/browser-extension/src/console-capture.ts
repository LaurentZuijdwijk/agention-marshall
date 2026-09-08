// The capture logic behind console-capture-main.ts, split out so it can be
// exercised against a jsdom window in tests — the entry point itself is a
// side effect on load and has no seam to test through.
//
// Everything here runs in the page's MAIN world (see manifest.json): a
// content script in the default isolated world has its own global object and
// would never see the page's console calls or its uncaught errors at all.
// MAIN-world scripts have no access to chrome.* APIs, so this only posts a
// window message; console-capture-relay.ts (isolated world) picks it up and
// is the thing that actually talks to the extension.
import { CONSOLE_CAPTURE_MARKER } from './protocol.js';

const LEVELS = ['log', 'warn', 'error', 'info', 'debug', 'trace'] as const;

export function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  try {
    // JSON.stringify returns undefined (not a string) for undefined and for
    // functions, so fall back rather than emitting a literal "undefined".
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Wraps the window's console and subscribes to the error events the console
 *  never sees, forwarding both to the relay as postMessage. */
export function installConsoleCapture(win: Window & typeof globalThis): void {
  const emit = (level: string, text: string): void => {
    try {
      win.postMessage({ __marshall: CONSOLE_CAPTURE_MARKER, level, text }, '*');
    } catch {
      // Never let capture break the page's own console.
    }
  };

  const console = win.console;
  for (const level of LEVELS) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      emit(level, args.map(stringify).join(' '));
      original(...args);
    };
  }

  // Uncaught exceptions never reach console.error — the browser prints them
  // to devtools itself — so the wrappers above miss exactly the failures the
  // agent most wants to see. Capture phase, because resource load errors
  // ('error' on an <img>/<script>/<link>) don't bubble.
  win.addEventListener('error', (event: ErrorEvent) => {
    const target = event.target as (Element & { src?: string; href?: string }) | null;
    if (target && target !== (win as unknown as EventTarget) && target.tagName) {
      const url = target.src ?? target.href ?? '';
      emit('error', `Failed to load ${target.tagName.toLowerCase()}${url ? `: ${url}` : ''}`);
      return;
    }
    const where = event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : '';
    emit('error', `Uncaught ${event.error ? stringify(event.error) : event.message}${where}`);
  }, true);

  win.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    emit('error', `Unhandled promise rejection: ${stringify(event.reason)}`);
  });
}
