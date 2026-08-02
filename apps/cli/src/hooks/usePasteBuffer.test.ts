import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPasteBuffer, shouldCollapse, placeholderFor } from './usePasteBuffer.js';

/** The hook is a ref around this; the behaviour worth testing is all in here. */
const buffer = () => createPasteBuffer();

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');

describe('shouldCollapse', () => {
  it('leaves a short paste alone', () => {
    assert.equal(shouldCollapse('one line'), false);
    assert.equal(shouldCollapse(lines(4)), false, 'a handful of lines is readable as-is');
  });

  it('collapses a tall paste', () => {
    assert.equal(shouldCollapse(lines(5)), true);
  });

  it('collapses a long single line', () => {
    assert.equal(shouldCollapse('x'.repeat(401)), true);
  });
});

describe('placeholderFor', () => {
  it('counts lines when there are several', () => {
    assert.equal(placeholderFor(1, lines(52)), '[paste #1: 52 lines]');
  });

  it('counts characters for one long line, where a line count says nothing', () => {
    assert.equal(placeholderFor(2, 'x'.repeat(900)), '[paste #2: 900 chars]');
  });
});

describe('usePasteBuffer', () => {
  it('returns short pastes untouched and stores nothing', () => {
    const paste = buffer();
    assert.equal(paste.capture('just a line'), 'just a line');
    assert.equal(paste.expand('just a line'), 'just a line');
  });

  it('round-trips a collapsed paste', () => {
    const paste = buffer();
    const text = lines(60);
    const placeholder = paste.capture(text);

    assert.notEqual(placeholder, text);
    assert.equal(paste.expand(placeholder), text);
  });

  it('expands a placeholder sitting inside typed text', () => {
    const paste = buffer();
    const placeholder = paste.capture(lines(10));

    assert.equal(
      paste.expand(`review this: ${placeholder} and say what breaks`),
      `review this: ${lines(10)} and say what breaks`,
    );
  });

  it('keeps two pastes apart', () => {
    const paste = buffer();
    const first = paste.capture(lines(10));
    const second = paste.capture(lines(20));

    assert.notEqual(first, second, 'each paste gets its own placeholder');
    assert.equal(paste.expand(`${first}|${second}`), `${lines(10)}|${lines(20)}`);
  });

  it('expands every occurrence of the same placeholder', () => {
    // Nothing stops the user copying the placeholder itself around the prompt.
    const paste = buffer();
    const placeholder = paste.capture(lines(10));

    assert.equal(paste.expand(`${placeholder} ${placeholder}`), `${lines(10)} ${lines(10)}`);
  });

  it('leaves a partly-deleted placeholder as the literal text it now is', () => {
    // Backspacing into a placeholder is a normal edit. It must not half-expand
    // or throw — what is left on screen is what gets sent.
    const paste = buffer();
    const placeholder = paste.capture(lines(10));
    const damaged = placeholder.slice(0, -1);

    assert.equal(paste.expand(damaged), damaged);
  });

  it('forgets captured text on clear', () => {
    const paste = buffer();
    const placeholder = paste.capture(lines(10));
    paste.clear();

    assert.equal(paste.expand(placeholder), placeholder, 'nothing left to expand to');
  });

  it('is not confused by text that merely looks like a placeholder', () => {
    const paste = buffer();
    assert.equal(paste.expand('[paste #1: 9 lines]'), '[paste #1: 9 lines]');
  });
});
