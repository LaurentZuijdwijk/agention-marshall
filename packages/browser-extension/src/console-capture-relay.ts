// The isolated-world half of console capture: receives postMessage events
// from console-capture-main.ts (MAIN world), buffers them, and answers the
// background service worker's drain request. See protocol.ts.
import { CONSOLE_CAPTURE_MARKER, DRAIN_CONSOLE_LOGS } from './protocol.js';
import type { ConsoleLogEntry } from './protocol.js';

const MAX_BUFFERED = 200;
const buffer: ConsoleLogEntry[] = [];

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data as { __marshall?: string; level?: string; text?: string } | null;
  if (!data || data.__marshall !== CONSOLE_CAPTURE_MARKER) return;
  buffer.push({ level: String(data.level), text: String(data.text) });
  if (buffer.length > MAX_BUFFERED) buffer.shift();
});

chrome.runtime.onMessage.addListener((message: { type?: string }, _sender, sendResponse) => {
  if (message?.type !== DRAIN_CONSOLE_LOGS) return false;
  sendResponse({ logs: buffer.splice(0, buffer.length) });
  return true;
});
