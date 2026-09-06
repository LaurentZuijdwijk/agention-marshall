/** One relayed command from the bridge server — see packages/plugin-browser/src/bridge.ts. */
export interface BridgeCommand {
  id: string;
  type: 'navigate' | 'screenshot' | 'click' | 'type' | 'read_page' | 'console_logs';
  params: Record<string, unknown>;
}

export interface BridgeResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** What the console-capture relay content script buffers and returns. */
export interface ConsoleLogEntry {
  level: string;
  text: string;
}

/** window.postMessage marker the MAIN-world capture script uses to reach the
 *  isolated-world relay — the two cannot share extension APIs directly. */
export const CONSOLE_CAPTURE_MARKER = '__marshall_console_capture__';

export const DRAIN_CONSOLE_LOGS = 'drain_console_logs';
