// The paste path end to end: terminal bytes in, rendered frame and submitted
// text out. The unit tests cover the pieces; this covers the wiring between
// them, which is where pasting was actually broken — the value was always
// intact, it was the frame that came out shredded.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React, { useState } from 'react';
import { InputPrompt } from './InputPrompt.js';
import { createPasteBuffer } from '../hooks/usePasteBuffer.js';
import { fakeStdout, fakeStdin, renderTui } from '../testing/ink.js';

const bracketed = (text: string) =>
  `\u001B[200~${text.replace(/\n/g, '\r')}\u001B[201~`;

const strip = (s: string) => s.replace(/\u001B\[[0-9;?]*[a-zA-Z]/g, '');
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

/** Poll until `written` reports a frame, so the test waits on Ink's throttled
 *  write rather than on a delay guessed to be long enough. */
async function waitForFrame(written: () => number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (written() === 0 && Date.now() < deadline) await tick();
}

async function mount() {
  let output = '';
  const submitted: string[] = [];

  // 76 columns: narrow enough that a long paste has to wrap.
  const stdout = fakeStdout(chunk => { output += chunk; }, 76);
  const stdin = fakeStdin();

  // The App's own wiring: capture on the way in, expand on the way out.
  const paste = createPasteBuffer();

  function Harness() {
    const [value, setValue] = useState('');
    return React.createElement(InputPrompt, {
      kind: 'task' as const,
      value,
      ghost: '',
      onPaste: paste.capture,
      onChange: setValue,
      onSubmit: (v: string) => { submitted.push(paste.expand(v)); setValue(''); },
    });
  }

  const instance = renderTui(React.createElement(Harness), { stdout, stdin });
  // Ink commits its first frame, and the paste listener attaches, a tick after
  // mount. Sending before that drops the paste on the floor.
  await waitForFrame(() => output.length);

  return {
    /**
     * Feed stdin a chunk at a time, resetting the capture before each one, so
     * what is left afterwards is the single frame that chunk produced — Ink
     * redraws the live region on every change, and concatenated frames make
     * "is this on screen?" unanswerable.
     */
    async send(...chunks: string[]) {
      for (const chunk of chunks) {
        output = '';
        stdin.push(chunk);
        await waitForFrame(() => output.length);
      }
      return strip(output);
    },
    get raw() { return output; },
    submitted,
    unmount: () => instance.unmount(),
  };
}

let active: { unmount(): void } | null = null;
afterEach(() => { active?.unmount(); active = null; });

const LONG = Array.from({ length: 10 }, (_, i) => `line number ${i}`).join('\n');

describe('InputPrompt paste', () => {
  it('draws a short multi-line paste as separate lines, with no stray CR', async () => {
    const prompt = await mount(); active = prompt;
    const frame = await prompt.send(bracketed('first\nsecond'));

    assert.ok(!prompt.raw.includes('\r'),
      'a CR in the frame returns the terminal to column 0 and overdraws the line');
    assert.match(frame, /first/);
    assert.match(frame, /second/);
    assert.ok(frame.indexOf('first') < frame.indexOf('second'), 'in order, on their own rows');
  });

  it('collapses a long paste to one row so the frame cannot outgrow the terminal', async () => {
    const prompt = await mount(); active = prompt;
    const frame = await prompt.send(bracketed(LONG));

    assert.match(frame, /\[paste #1: 10 lines\]/);
    assert.doesNotMatch(frame, /line number 7/, 'the text itself is held back, not drawn');
  });

  it('sends the pasted text in full, with what was typed around it', async () => {
    const prompt = await mount(); active = prompt;
    await prompt.send(bracketed('review this:'), ' ', bracketed(LONG), ' please', '\r');

    assert.deepEqual(prompt.submitted, [`review this: ${LONG} please`]);
  });

  it('keeps two collapsed pastes distinct', async () => {
    const prompt = await mount(); active = prompt;
    await prompt.send(bracketed(LONG), ' / ', bracketed(`${LONG}\nand more`), '\r');

    assert.deepEqual(prompt.submitted, [`${LONG} / ${LONG}\nand more`]);
  });

  it('drops the line ending a copied line brings with it', async () => {
    // The wizard and the login prompt use this same component for a single
    // value, where a pasted terminator would be welded onto the API key.
    const prompt = await mount(); active = prompt;
    await prompt.send(bracketed('sk-ant-secret\n'), '\r');

    assert.deepEqual(prompt.submitted, ['sk-ant-secret']);
  });

  it('keeps the line breaks inside a collapsed paste', async () => {
    const prompt = await mount(); active = prompt;
    await prompt.send(bracketed(`${LONG}\n`), '\r');

    assert.deepEqual(prompt.submitted, [LONG], 'only the trailing one goes');
  });
});
