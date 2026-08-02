// Driven through a real Ink render rather than by calling the key handler
// directly: the cursor logic lives in `useInput`, and the bug it was written to
// prevent (a parent rewriting `value` mid-edit) only shows up across renders.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import React, { useState } from 'react';
import { render } from 'ink';
import { TextInput } from './TextInput.js';

// ── harness ───────────────────────────────────────────────────────────────────

const KEY = {
  left:      '\u001B[D',
  right:     '\u001B[C',
  backspace: '\u007F',
  enter:     '\r',
};

/** What a terminal in bracketed-paste mode actually puts on stdin. */
const paste = (text: string) => `\u001B[200~${text}\u001B[201~`;

function fakeStdout(sink: (chunk: string) => void): Writable {
  const stdout = new Writable({
    write(chunk, _encoding, cb) { sink(chunk.toString()); cb(); },
  }) as Writable & { isTTY: boolean; columns: number; rows: number };
  stdout.isTTY = true;
  stdout.columns = 100;
  stdout.rows = 30;
  return stdout;
}

function fakeStdin(): Readable & { isTTY: boolean; setRawMode(m: boolean): void } {
  const stdin = new Readable({ read() {} }) as Readable & {
    isTTY: boolean; setRawMode: (mode: boolean) => void; ref: () => void; unref: () => void;
  };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  return stdin;
}

const strip = (s: string) => s.replace(/\u001B\[[0-9;?]*[a-zA-Z]/g, '');
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
/** Ink commits its first frame a tick after mount. */
const tickTwice = async () => { await tick(); await tick(); };

/**
 * A controlled TextInput, the way the App uses it: the parent owns the value.
 * `rewrite` lets a test act as the parent and replace the value mid-edit.
 */
function mount(options: {
  initial?: string;
  mask?: string;
  placeholder?: string;
  onPaste?: (text: string) => string;
} = {}) {
  let output = '';
  const submitted: string[] = [];
  let rewrite: (value: string) => void = () => {};
  let latest = options.initial ?? '';

  function Harness() {
    const [value, setValue] = useState(options.initial ?? '');
    rewrite = setValue;
    latest = value;
    return React.createElement(TextInput, {
      value,
      mask: options.mask,
      placeholder: options.placeholder,
      onPaste: options.onPaste,
      onChange: setValue,
      onSubmit: (v: string) => { submitted.push(v); setValue(''); },
    });
  }

  const stdin = fakeStdin();
  const instance = render(React.createElement(Harness), {
    stdout: fakeStdout(chunk => { output += chunk; }),
    stdin,
    patchConsole: false,
  });

  return {
    async type(...keys: string[]) {
      for (const key of keys) {
        stdin.push(key);
        await tick();
      }
    },
    async setValue(value: string) { rewrite(value); await tick(); },
    get value() { return latest; },
    /** Everything written so far, ANSI removed — Ink emits control sequences and
     *  text in separate chunks, so the last chunk alone is rarely the frame. */
    get screen() { return strip(output); },
    /** With the control sequences left in, for assertions about terminal modes. */
    get raw() { return output; },
    submitted,
    unmount: () => instance.unmount(),
  };
}

let active: { unmount(): void } | null = null;
afterEach(() => { active?.unmount(); active = null; });

// ── tests ─────────────────────────────────────────────────────────────────────

describe('TextInput', () => {
  it('appends typed characters', async () => {
    const input = mount(); active = input;
    await input.type('a', 'b', 'c');
    assert.equal(input.value, 'abc');
  });

  it('inserts at the cursor after moving left', async () => {
    const input = mount(); active = input;
    await input.type('a', 'c');
    await input.type(KEY.left);
    await input.type('b');
    assert.equal(input.value, 'abc');
  });

  it('deletes the character before the cursor', async () => {
    const input = mount(); active = input;
    await input.type('a', 'b', 'c', KEY.backspace);
    assert.equal(input.value, 'ab');
  });

  it('deletes mid-string, not from the end', async () => {
    const input = mount(); active = input;
    await input.type('a', 'b', 'c', KEY.left, KEY.backspace);
    assert.equal(input.value, 'ac');
  });

  it('does nothing when backspacing at the start', async () => {
    const input = mount(); active = input;
    await input.type('a', KEY.left, KEY.backspace, KEY.backspace);
    assert.equal(input.value, 'a');
  });

  it('will not move the cursor past either end', async () => {
    const input = mount(); active = input;
    await input.type('a', KEY.left, KEY.left, KEY.left);
    await input.type('X');
    assert.equal(input.value, 'Xa', 'cursor stopped at the start');

    await input.type(KEY.right, KEY.right, KEY.right, KEY.right);
    await input.type('Z');
    assert.equal(input.value, 'XaZ', 'cursor stopped at the end');
  });

  it('submits the current value and clears', async () => {
    const input = mount(); active = input;
    await input.type('h', 'i', KEY.enter);
    assert.deepEqual(input.submitted, ['hi']);
    assert.equal(input.value, '');
  });

  it('keeps typing after a submit', async () => {
    const input = mount(); active = input;
    await input.type('h', 'i', KEY.enter);
    await input.type('o', 'k');
    assert.equal(input.value, 'ok');
  });

  it('ignores tab, so the parent can use it for completion', async () => {
    const input = mount(); active = input;
    await input.type('/', 'm', '\t');
    assert.equal(input.value, '/m');
  });

  it('ignores ctrl- chords, which belong to the app', async () => {
    // ctrl-V used to type a "v" here while also attaching the clipboard image
    // in the App. Both wrote the value for the same keystroke, the App's write
    // lost the race, and the [image #1] label it had just inserted vanished —
    // so the image was dropped at submit with nothing on screen to explain it.
    const input = mount({ initial: 'hi' }); active = input;
    await input.type('\u0016', '\u0012', '\u0001'); // ctrl-V, ctrl-R, ctrl-A

    assert.equal(input.value, 'hi', 'no chord may leave a character behind');
  });

  it('ignores alt- chords for the same reason', async () => {
    const input = mount({ initial: 'hi' }); active = input;
    await input.type('\u001Bb', '\u001Bf'); // alt-b, alt-f (word motion)

    assert.equal(input.value, 'hi');
  });

  it('puts the cursor at the end when the parent rewrites the value', async () => {
    // The autocomplete path: the App appends the ghost text itself. If the
    // cursor stayed where it was, the next keystroke would land mid-word —
    // "/mo" completed to "/model" then typing "x" gave "/moxdel".
    const input = mount({ initial: '/mo' }); active = input;
    await input.type(KEY.left, KEY.left);
    await input.setValue('/model');
    await input.type('x');
    assert.equal(input.value, '/modelx');
  });

  it('masks the value but still edits the real characters', async () => {
    const input = mount({ mask: '*' }); active = input;
    await input.type('s', 'e', 'c');
    assert.equal(input.value, 'sec');
    assert.match(input.screen, /\*\*\*/);
    assert.doesNotMatch(input.screen, /sec/, 'an API key must never reach the screen');

    await input.type(KEY.backspace);
    assert.equal(input.value, 'se');
  });

  it('shows the placeholder only while empty', async () => {
    const input = mount({ placeholder: 'type a task' }); active = input;
    await tickTwice();
    assert.match(input.screen, /type a task/);

    await input.type('x');
    const after = input.screen.slice(input.screen.lastIndexOf('type a task') + 1);
    assert.match(after, /x/);
  });

  describe('paste', () => {
    it('turns on bracketed paste mode', async () => {
      // This is what makes the terminal wrap pasted text in markers, so it can
      // be told apart from typing. Without it a paste is just keystrokes, and a
      // chunk boundary landing on a line break submits the prompt mid-paste.
      const input = mount(); active = input;
      await tickTwice();

      assert.match(input.raw, /\[\?2004h/);
    });

    it('keeps a multi-line paste whole, as newlines', async () => {
      // The bug: terminals send line breaks in pasted text as CR, and a CR left
      // in the value makes the terminal redraw each line over the last one.
      const input = mount(); active = input;
      await input.type(paste('first\rsecond\r\nthird'));

      assert.equal(input.value, 'first\nsecond\nthird');
      assert.ok(!input.value.includes('\r'), 'no carriage return may survive into the value');
    });

    it('does not submit on the newlines inside a paste', async () => {
      const input = mount(); active = input;
      await input.type(paste('one\rtwo'));

      assert.deepEqual(input.submitted, [], 'a pasted line break is text, not enter');
    });

    it('still submits on a real enter after a paste', async () => {
      const input = mount(); active = input;
      await input.type(paste('one\rtwo'));
      await input.type(KEY.enter);

      assert.deepEqual(input.submitted, ['one\ntwo']);
    });

    it('inserts the paste at the cursor, not at the end', async () => {
      const input = mount({ initial: 'ac' }); active = input;
      await input.type(KEY.left);
      await input.type(paste('b'));

      assert.equal(input.value, 'abc');
    });

    it('inserts what onPaste returns, and reports the original to it', async () => {
      const seen: string[] = [];
      const input = mount({ onPaste: (text) => { seen.push(text); return '[collapsed]'; } });
      active = input;
      await input.type(paste('lots\rof\rlines'));

      assert.deepEqual(seen, ['lots\nof\nlines'], 'onPaste sees normalised text, in full');
      assert.equal(input.value, '[collapsed]');
    });

    it('normalises a paste that arrives as plain keystrokes', async () => {
      // Terminals that ignore bracketed paste deliver the text through the
      // ordinary input channel, where it is the CR that does the damage.
      const input = mount(); active = input;
      await input.type('alpha\rbeta');

      assert.equal(input.value, 'alpha\nbeta');
    });

    it('routes an unbracketed multi-line paste through onPaste too', async () => {
      const input = mount({ onPaste: () => '[collapsed]' }); active = input;
      await input.type('alpha\rbeta');

      assert.equal(input.value, '[collapsed]');
    });

    it('drops the line ending a copied line brings with it', async () => {
      // Copying a line from a browser or a file takes its terminator too. In a
      // single-value field that terminator is never wanted: the wizard's API key
      // would be saved with a newline welded onto it.
      const input = mount(); active = input;
      await input.type(paste('sk-ant-secret\r'));

      assert.equal(input.value, 'sk-ant-secret');
      assert.deepEqual(input.submitted, [], 'and it still is not an enter');
    });

    it('drops a trailing line ending from an unbracketed paste too', async () => {
      const input = mount(); active = input;
      await input.type('sk-ant-secret\r');

      assert.equal(input.value, 'sk-ant-secret');
    });

    it('keeps the line breaks inside the text, only the trailing ones go', async () => {
      const input = mount(); active = input;
      await input.type(paste('first\r\rsecond\r\r'));

      assert.equal(input.value, 'first\n\nsecond');
    });

    it('ignores a paste that is nothing but line endings', async () => {
      const input = mount({ initial: 'kept' }); active = input;
      await input.type(paste('\r\r'));

      assert.equal(input.value, 'kept');
    });

    it('leaves ordinary typing alone when onPaste is set', async () => {
      const input = mount({ onPaste: () => '[collapsed]' }); active = input;
      await input.type('a', 'b');

      assert.equal(input.value, 'ab', 'single characters are not pastes');
    });
  });
});
