import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { panelLayout, panelWidth, safeWidth, STATUS_ROWS, PROMPT_ROWS, MIN_PANEL_ROWS, MIN_TERMINAL_ROWS } from './layout.js';
import { APPROVAL_CHROME_ROWS, detailWindow } from './ApprovalPanel.js';

/**
 * The one property that matters: whatever renders below <Static> has to be
 * strictly shorter than the terminal. Ink's fallback for an oversized frame is
 * to clear the screen and reprint the entire static transcript, on every render
 * — the flicker, the wiped scrollback and the doubled rows are all that one
 * branch. So these tests assert the total, not the parts.
 */
function approvalFrameRows(terminalRows: number, extraProvenanceRows = 0): number {
  const { rows, showPrompt } = panelLayout(terminalRows);
  const budget = rows - APPROVAL_CHROME_ROWS - extraProvenanceRows;
  const { shown, hidden } = detailWindow(Array.from({ length: 500 }, (_, i) => `line ${i}`), budget);
  const panelRows = APPROVAL_CHROME_ROWS + extraProvenanceRows + shown.length + (hidden > 0 ? 1 : 0);
  return panelRows + STATUS_ROWS + (showPrompt ? PROMPT_ROWS : 0);
}

describe('panelLayout', () => {
  it('leaves the approval frame shorter than the terminal', () => {
    for (let terminalRows = MIN_TERMINAL_ROWS; terminalRows <= 200; terminalRows++) {
      for (const provenance of [0, 1, 2]) {
        assert.ok(
          approvalFrameRows(terminalRows, provenance) < terminalRows,
          `rows=${terminalRows} provenance=${provenance}: frame is ${approvalFrameRows(terminalRows, provenance)}`,
        );
      }
    }
  });

  it('never renders a panel taller than the rows it was given', () => {
    // Separate from the property above, and it caught a real off-by-one: at zero
    // detail budget the "… N more lines" notice was rendering as a row outside
    // the budget, so the panel overran what the layout had promised it.
    for (let terminalRows = 12; terminalRows <= 200; terminalRows++) {
      const { rows } = panelLayout(terminalRows);
      for (const provenance of [0, 1, 2]) {
        const chrome = APPROVAL_CHROME_ROWS + provenance;
        const { shown, hidden } = detailWindow(Array.from({ length: 200 }, (_, i) => `line ${i}`), rows - chrome);
        const rendered = chrome + shown.length + (hidden > 0 ? 1 : 0);
        assert.ok(rendered <= rows,
          `rows=${terminalRows} provenance=${provenance}: panel rendered ${rendered} into a budget of ${rows}`);
      }
    }
  });

  it('drops the queue-a-prompt input before it drops the panel', () => {
    assert.equal(panelLayout(40).showPrompt, true);
    assert.equal(panelLayout(24).showPrompt, false);
  });

  it('never returns a panel too small to say what is being approved', () => {
    for (let terminalRows = 0; terminalRows < 24; terminalRows++) {
      assert.ok(panelLayout(terminalRows).rows >= MIN_PANEL_ROWS, `rows=${terminalRows}`);
    }
  });

  it('gives a tall terminal more of the detail than the old fixed cap did', () => {
    // The cap used to be 20 lines regardless of terminal size.
    assert.ok(panelLayout(60).rows - APPROVAL_CHROME_ROWS > 20);
  });
});

describe('safeWidth', () => {
  it('holds back the last columns of the terminal', () => {
    assert.equal(safeWidth(100), 98);
  });

  it('stays usable on a very narrow terminal', () => {
    assert.equal(safeWidth(10), 20);
  });
});

describe('panelWidth', () => {
  it('leaves room for the border and padding inside the root gutter', () => {
    assert.equal(panelWidth(100), 94);
  });

  it('never claims more room than the root actually renders into', () => {
    // Drift here is invisible until it isn't: a panel that thinks it is wider
    // than the root wraps after all, and every row budget built on it is short.
    for (let columns = 40; columns <= 300; columns++) {
      assert.ok(panelWidth(columns) <= safeWidth(columns), `columns=${columns}`);
    }
  });

  it('stays usable on a very narrow terminal', () => {
    assert.equal(panelWidth(10), 20);
  });
});

describe('detailWindow', () => {
  it('shows everything when it fits', () => {
    const { shown, hidden } = detailWindow(['a', 'b', 'c'], 10);
    assert.deepEqual(shown, ['a', 'b', 'c']);
    assert.equal(hidden, 0);
  });

  it('keeps the head, and spends one row saying what it dropped', () => {
    const { shown, hidden } = detailWindow(['a', 'b', 'c', 'd', 'e'], 3);
    assert.deepEqual(shown, ['a', 'b'], 'a diff reads from the top');
    assert.equal(hidden, 3);
    assert.equal(shown.length + 1, 3, 'the notice has to fit inside the budget too');
  });

  it('renders nothing at all on a zero budget, not even the notice', () => {
    // The notice is a row like any other. Reporting `hidden` here would put it
    // outside the budget, which is how the panel came to be one row taller than
    // the layout promised — and one row taller than the viewport is the bug the
    // whole budget exists to prevent.
    const { shown, hidden } = detailWindow(['a', 'b'], 0);
    assert.deepEqual(shown, []);
    assert.equal(hidden, 0);
  });
});
