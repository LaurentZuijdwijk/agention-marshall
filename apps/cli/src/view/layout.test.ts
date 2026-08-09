import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { panelLayout, panelWidth, safeWidth, STATUS_ROWS, PROMPT_ROWS, MIN_PANEL_ROWS, MIN_TERMINAL_ROWS } from './layout.js';
import { APPROVAL_CHROME_ROWS, detailRows, detailWindow } from './ApprovalPanel.js';

const plainLines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`);

/** A diff whose first change sits behind the context formatFileDiff keeps. */
const diffLines = (n: number) => [
  '@@ 12 unchanged lines @@',
  ' const a = 1;',
  ' const b = 2;',
  ' const c = 3;',
  ...Array.from({ length: n }, (_, i) => `${i % 2 ? '+' : '-'} changed ${i}`),
];

/** Rows the detail block actually renders, notices included. */
function detailBlockRows(lines: string[], budget: number, isDiff: boolean): number {
  const { shown, hidden, skipped } = detailWindow(lines, budget, isDiff);
  return shown.length + (hidden > 0 ? 1 : 0) + (skipped > 0 ? 1 : 0);
}

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
  const panelRows = APPROVAL_CHROME_ROWS + extraProvenanceRows + detailBlockRows(plainLines(500), budget, false);
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
        // Both detail shapes: a diff renders up to two notices (what it skipped
        // above the first change, what it dropped below), so it is the one that
        // can overrun a budget the plain path fits exactly.
        for (const [lines, isDiff] of [[plainLines(200), false], [diffLines(200), true]] as const) {
          const rendered = chrome + detailBlockRows(lines, rows - chrome, isDiff);
          assert.ok(rendered <= rows,
            `rows=${terminalRows} provenance=${provenance} isDiff=${isDiff}: panel rendered ${rendered} into a budget of ${rows}`);
        }
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

describe('detailRows', () => {
  it('drops the path header a file diff opens with', () => {
    // The description row right above the detail already names the file, and on
    // a short terminal these two rows were half of the whole window.
    const { lines, isDiff } = detailRows('--- src/a.ts\n+++ src/a.ts\n- old\n+ new');
    assert.deepEqual(lines, ['- old', '+ new']);
    assert.equal(isDiff, true);
  });

  it('leaves anything that is not a diff alone', () => {
    const { lines, isDiff } = detailRows('rm -rf build\n--yes');
    assert.deepEqual(lines, ['rm -rf build', '--yes']);
    assert.equal(isDiff, false);
  });
});

describe('detailWindow', () => {
  it('shows everything when it fits', () => {
    const { shown, hidden, skipped } = detailWindow(['a', 'b', 'c'], 10);
    assert.deepEqual(shown, ['a', 'b', 'c']);
    assert.equal(hidden, 0);
    assert.equal(skipped, 0);
  });

  it('keeps the head, and spends one row saying what it dropped', () => {
    const { shown, hidden, skipped } = detailWindow(['a', 'b', 'c', 'd', 'e'], 3);
    assert.deepEqual(shown, ['a', 'b'], 'anything but a diff reads from the top');
    assert.equal(hidden, 3);
    assert.equal(skipped, 0);
    assert.equal(shown.length + 1, 3, 'the notice has to fit inside the budget too');
  });

  it('windows a diff around its first change, not its first line', () => {
    // Without this the whole budget goes to the context above the change: the
    // reader is shown the code around an edit and never the edit.
    const lines = [' ctx a', ' ctx b', ' ctx c', '- gone', '+ added', ' ctx d'];
    const { shown, hidden, skipped } = detailWindow(lines, 4, true);
    assert.equal(skipped, 2, 'one line of lead context is kept');
    assert.deepEqual(shown, [' ctx c', '- gone'], 'and the change is in frame');
    assert.equal(hidden, 2);
    assert.equal(1 + shown.length + 1, 4, 'both notices are inside the budget');
  });

  it('gives rows the anchor did not need back to the context above it', () => {
    // Anchoring on the change is a floor, not a target: if the tail leaves rows
    // spare, showing more of what led up to the change beats a short panel.
    const lines = [' a', ' b', ' c', ' d', ' e', '- gone', '+ added'];
    const { shown, hidden, skipped } = detailWindow(lines, 6, true);
    assert.equal(skipped, 2, 'anchoring alone would have skipped 4');
    assert.deepEqual(shown, [' c', ' d', ' e', '- gone', '+ added']);
    assert.equal(hidden, 0);
    assert.equal(1 + shown.length, 6, 'the whole budget is used');
  });

  it('does not anchor a shell command on its flags', () => {
    // A leading `-` is a flag here, and a command has to be read from its first
    // word — `rm` is the part that matters, not `-rf`.
    const { shown, skipped } = detailWindow(['rm \\', '-rf \\', 'build', 'dist'], 3, false);
    assert.deepEqual(shown, ['rm \\', '-rf \\']);
    assert.equal(skipped, 0);
  });

  it('reads a diff from the top when the budget is too small to anchor', () => {
    // The skipped-lines notice costs a row. Below this size it takes back more
    // than the anchoring gives.
    const lines = [' ctx a', ' ctx b', ' ctx c', '- gone', '+ added'];
    const { shown, skipped } = detailWindow(lines, 3, true);
    assert.deepEqual(shown, [' ctx a', ' ctx b']);
    assert.equal(skipped, 0);
  });

  it('renders nothing at all on a zero budget, not even the notice', () => {
    // The notice is a row like any other. Reporting `hidden` here would put it
    // outside the budget, which is how the panel came to be one row taller than
    // the layout promised — and one row taller than the viewport is the bug the
    // whole budget exists to prevent.
    const { shown, hidden, skipped } = detailWindow(['a', 'b'], 0);
    assert.deepEqual(shown, []);
    assert.equal(hidden, 0);
    assert.equal(skipped, 0);
  });
});
