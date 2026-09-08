// Runs the MAIN-world capture against a real jsdom window: the point of these
// tests is the wiring to the page's own console and error events, which a
// fake object wouldn't exercise.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { installConsoleCapture, stringify } from './console-capture.js';
import { CONSOLE_CAPTURE_MARKER } from './protocol.js';

type Captured = { level: string; text: string };

let win: JSDOM['window'];
let captured: Captured[];

beforeEach(() => {
  const dom = new JSDOM('<body></body>', { url: 'https://example.com/page', runScripts: 'dangerously' });
  win = dom.window;
  captured = [];
  win.addEventListener('message', (event: MessageEvent) => {
    if (event.data?.__marshall === CONSOLE_CAPTURE_MARKER) {
      captured.push({ level: event.data.level, text: event.data.text });
    }
  });
  installConsoleCapture(win as unknown as Window & typeof globalThis);
});

/** postMessage is queued as a task, so let the loop turn before asserting. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('console wrappers', () => {
  test('captures each level with joined arguments', async () => {
    win.console.log('hello', 42);
    win.console.warn('careful');
    win.console.error('boom');
    await flush();
    assert.deepEqual(captured, [
      { level: 'log', text: 'hello 42' },
      { level: 'warn', text: 'careful' },
      { level: 'error', text: 'boom' },
    ]);
  });

  test('serialises an Error argument with its stack', async () => {
    win.console.error(new Error('kaboom'));
    await flush();
    assert.match(captured[0].text, /Error: kaboom/);
  });
});

describe('error events', () => {
  test('captures an uncaught exception the console never sees', async () => {
    const error = new Error('exploded');
    win.dispatchEvent(new win.ErrorEvent('error', {
      error, message: 'Uncaught Error: exploded', filename: 'https://example.com/app.js', lineno: 12, colno: 3,
    }));
    await flush();
    assert.equal(captured[0].level, 'error');
    assert.match(captured[0].text, /Uncaught Error: exploded/);
    assert.match(captured[0].text, /app\.js:12:3/);
  });

  test('captures a failed resource load', async () => {
    const img = win.document.createElement('img');
    img.src = 'https://example.com/missing.png';
    win.document.body.appendChild(img);
    img.dispatchEvent(new win.Event('error'));
    await flush();
    assert.deepEqual(captured, [
      { level: 'error', text: 'Failed to load img: https://example.com/missing.png' },
    ]);
  });

  test('captures an unhandled promise rejection', async () => {
    const event = new win.Event('unhandledrejection') as Event & { reason?: unknown };
    event.reason = new Error('nope');
    win.dispatchEvent(event);
    await flush();
    assert.match(captured[0].text, /Unhandled promise rejection: Error: nope/);
  });
});

describe('stringify', () => {
  test('falls back to String() for values JSON cannot represent', () => {
    assert.equal(stringify(undefined), 'undefined');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.equal(stringify(cyclic), '[object Object]');
  });
});
