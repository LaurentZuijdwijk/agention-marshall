import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitLiveRows, liveWidth } from './LiveOutput.js';
import { clampToRows } from '../format.js';

describe('splitLiveRows', () => {
  it('gives one block the whole budget when it is alone', () => {
    const { stream, reasoning } = splitLiveRows(30, false);
    assert.equal(stream, 20);
    assert.equal(reasoning, 20);
  });

  it('splits the budget when both are live', () => {
    const { stream, reasoning } = splitLiveRows(30, true);
    assert.equal(stream + reasoning, 20, 'together they must still fit the budget');
    assert.equal(stream, 10);
    assert.equal(reasoning, 10);
  });

  it('never lets the two blocks exceed the budget on an odd split', () => {
    for (let rows = 14; rows < 120; rows++) {
      const { stream, reasoning } = splitLiveRows(rows, true);
      const budget = Math.max(3, rows - 10);
      assert.ok(stream + reasoning <= budget,
        `rows=${rows}: ${stream}+${reasoning} overflows a budget of ${budget}`);
    }
  });

  it('keeps both blocks visible on a very short terminal', () => {
    // A 10-row terminal has no budget left at all; both blocks still get rows
    // rather than collapsing to zero and rendering an empty frame.
    const { stream, reasoning } = splitLiveRows(10, true);
    assert.ok(stream >= 2 && reasoning >= 2);
  });

  it('is stable as the terminal shrinks — never negative', () => {
    for (let rows = 0; rows < 12; rows++) {
      for (const both of [true, false]) {
        const split = splitLiveRows(rows, both);
        assert.ok(split.stream > 0 && split.reasoning > 0, `rows=${rows} both=${both}`);
      }
    }
  });
});

describe('liveWidth', () => {
  it('leaves room for the gutter', () => {
    assert.equal(liveWidth(100), 98);
  });

  it('stays usable on a very narrow terminal', () => {
    assert.equal(liveWidth(10), 20);
    assert.equal(liveWidth(0), 20);
  });
});

describe('the budget actually holds', () => {
  /** What the component renders has to fit the rows it was allotted, or Ink
   *  scrolls the live region and its erase bookkeeping goes wrong. */
  it('clamps long output to the split budget', () => {
    const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    const { stream, reasoning } = splitLiveRows(40, true);
    const width = liveWidth(80);

    assert.ok(clampToRows(long, width, stream).split('\n').length <= stream);
    assert.ok(clampToRows(long, width, reasoning).split('\n').length <= reasoning);
  });

  it('clamps wrapped text too, not just newlines', () => {
    const wide = 'x'.repeat(5000);
    const rows = 6;
    assert.ok(clampToRows(wide, 40, rows).split('\n').length <= rows);
  });
});
