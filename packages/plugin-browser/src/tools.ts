import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExtensionBridge } from './bridge.js';

/**
 * The v1 tool set: navigate, screenshot, click, type, read the page, and read
 * console output. Each relays one command to the extension over the bridge
 * and shapes the result as an MCP `CallToolResult`.
 *
 * Deliberately not here: multi-tab management, full-page screenshot
 * stitching, an `eval`-style arbitrary-JS tool, and accessibility-tree
 * reading — real value, real added risk or complexity, worth their own pass.
 *
 * A rejected `bridge.call` (no extension connected, a timeout, a JS error
 * inside the page) is left to throw: the MCP SDK converts a thrown tool
 * error into `{ isError: true }` automatically, which is exactly the "tell
 * the model, don't crash the turn" behaviour every tool here wants.
 */
export function registerBrowserTools(server: McpServer, bridge: ExtensionBridge): void {
  server.registerTool(
    'browser_navigate',
    {
      description: "Navigate the active browser tab to a URL.",
      inputSchema: { url: z.string().describe('The URL to navigate to, including scheme (e.g. https://example.com)') },
    },
    async ({ url }) => {
      await bridge.call('navigate', { url });
      return textResult(`Navigated to ${url}.`);
    },
  );

  server.registerTool(
    'browser_screenshot',
    {
      description: "Capture a screenshot of the active browser tab's visible viewport.",
      inputSchema: {},
    },
    async () => {
      const result = await bridge.call('screenshot', {}) as ScreenshotResult;
      const label = [result.title, result.url].filter(Boolean).join(' — ');
      return {
        content: [
          { type: 'text' as const, text: `Captured the active tab${label ? ` (${label})` : ''}.` },
          { type: 'image' as const, data: result.data, mimeType: result.mimeType || 'image/png' },
        ],
      };
    },
  );

  server.registerTool(
    'browser_click',
    {
      description: 'Click the first element matching a CSS selector on the active tab.',
      inputSchema: { selector: z.string().describe('CSS selector of the element to click') },
    },
    async ({ selector }) => {
      await bridge.call('click', { selector });
      return textResult(`Clicked "${selector}".`);
    },
  );

  server.registerTool(
    'browser_type',
    {
      description: 'Type text into the first input/textarea matching a CSS selector on the active tab.',
      inputSchema: {
        selector: z.string().describe('CSS selector of the field to type into'),
        text: z.string().describe('Text to type'),
      },
    },
    async ({ selector, text }) => {
      await bridge.call('type', { selector, text });
      return textResult(`Typed into "${selector}".`);
    },
  );

  server.registerTool(
    'browser_read_page',
    {
      description:
        "Read the active tab's content. 'markdown' (default) keeps structure " +
        "(headings, lists, links with their href) at a fraction of 'html''s " +
        "cost — use it when you need to act on a link and not just read copy. " +
        "'text' is the visible, whitespace-collapsed text only — cheaper still " +
        "when structure and links don't matter. 'html' is the full page markup " +
        '— use it only when you need real tags/attributes/classes (e.g. to find ' +
        'a CSS selector), since it costs far more.',
      inputSchema: {
        format: z.enum(['markdown', 'text', 'html']).optional()
          .describe("'markdown' (default), 'text', or 'html'"),
      },
    },
    async ({ format }) => {
      const result = await bridge.call('read_page', { format: format ?? 'markdown' }) as ReadPageResult;
      const header = [result.title, result.url].filter(Boolean).join(' — ');
      const body = capText(result.text, MAX_PAGE_TEXT_CHARS);
      return textResult(header ? `${header}\n\n${body}` : body);
    },
  );

  server.registerTool(
    'browser_press_key',
    {
      description:
        'Press a key on the active tab, optionally with modifiers — for ' +
        "submitting a form with Enter, dismissing a dialog with Escape, or " +
        "moving focus with Tab/arrow keys, none of which browser_type covers. " +
        'Targets the focused element by default, or a specific one via selector.',
      inputSchema: {
        key: z.string().describe(
          "The key to press: a named key ('Enter', 'Escape', 'Tab', 'Backspace', " +
          "'Delete', 'ArrowUp'/'ArrowDown'/'ArrowLeft'/'ArrowRight', 'Home', 'End', " +
          "'PageUp', 'PageDown', ' ') or a single printable character (e.g. 'a').",
        ),
        selector: z.string().optional()
          .describe('CSS selector of the element to focus first; defaults to the currently focused element'),
        ctrlKey: z.boolean().optional().describe('Hold Ctrl'),
        shiftKey: z.boolean().optional().describe('Hold Shift'),
        altKey: z.boolean().optional().describe('Hold Alt'),
        metaKey: z.boolean().optional().describe('Hold Meta/Cmd'),
      },
    },
    async ({ key, selector, ctrlKey, shiftKey, altKey, metaKey }) => {
      await bridge.call('press_key', { key, selector, ctrlKey, shiftKey, altKey, metaKey });
      return textResult(`Pressed "${key}"${selector ? ` on "${selector}"` : ''}.`);
    },
  );

  server.registerTool(
    'browser_console_logs',
    {
      description: 'Read recent console output from the active tab, including uncaught exceptions, '
        + 'unhandled promise rejections and failed resource loads. Draining is destructive: each call '
        + 'returns only what was captured since the last one.',
      inputSchema: {},
    },
    async () => {
      const result = await bridge.call('console_logs', {}) as ConsoleLogsResult;
      if (result.logs.length === 0) return textResult('No console messages captured.');
      return textResult(result.logs.map(l => `[${l.level}] ${l.text}`).join('\n'));
    },
  );
}

interface ScreenshotResult { data: string; mimeType: string; url?: string; title?: string }
interface ReadPageResult { text: string; url?: string; title?: string }
interface ConsoleLogsResult { logs: { level: string; text: string }[] }

/** A page (especially 'html' mode) can dwarf a turn's whole budget otherwise;
 *  a clear truncation marker beats a silent cutoff. */
export const MAX_PAGE_TEXT_CHARS = 100_000;

function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[...truncated at ${max.toLocaleString()} characters...]`;
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}
