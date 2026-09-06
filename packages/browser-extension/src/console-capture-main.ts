// Runs in the page's MAIN world (see manifest.json) so it wraps the page's
// *own* console — a content script in the default isolated world has its own
// global object and would never see the page's console calls at all. MAIN-
// world scripts have no access to chrome.* APIs, so this only posts a
// window message; console-capture-relay.ts (isolated world) picks it up and
// is the thing that actually talks to the extension.
import { CONSOLE_CAPTURE_MARKER } from './protocol.js';

const LEVELS = ['log', 'warn', 'error', 'info', 'debug'] as const;

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

for (const level of LEVELS) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    try {
      window.postMessage(
        { __marshall: CONSOLE_CAPTURE_MARKER, level, text: args.map(stringify).join(' ') },
        '*',
      );
    } catch {
      // Never let capture break the page's own console.
    }
    original(...args);
  };
}
