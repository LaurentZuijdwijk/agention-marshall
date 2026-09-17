import { it } from 'node:test';
import assert from 'node:assert/strict';
import { setTerminalTitle } from './terminal-title.js';

it('sets a Marshall workspace title, then clears and pops it exactly once', () => {
  const writes: string[] = [];
  const restore = setTerminalTitle('/work/my-project', { isTTY: true, write: text => writes.push(text) });
  assert.deepEqual(writes, ['\x1b[22;0t\x1b]0;Marshall — my-project\x07']);
  restore();
  restore();
  assert.deepEqual(writes, ['\x1b[22;0t\x1b]0;Marshall — my-project\x07', '\x1b]0;\x07\x1b[23;0t'],
    'the clear comes first, so a terminal that honours the stack still wins');
});

it('leaves redirected output alone', () => {
  setTerminalTitle('/work/project', { write: () => assert.fail('unexpected write') })();
});

it('strips terminal control characters from workspace names', () => {
  const writes: string[] = [];
  setTerminalTitle('/work/bad\x07\x1b\n\x9cname', { isTTY: true, write: text => writes.push(text) });
  assert.equal(writes[0], '\x1b[22;0t\x1b]0;Marshall — badname\x07');
});
