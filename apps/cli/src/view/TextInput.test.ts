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
function mount(options: { initial?: string; mask?: string; placeholder?: string } = {}) {
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
});
