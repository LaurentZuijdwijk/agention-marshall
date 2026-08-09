// ── the height budget for everything below <Static> ───────────────────────────
//
// Ink redraws the non-static region by rewinding the cursor over the rows it
// wrote last time. That only works while the region fits the viewport: one row
// too many and Ink takes its fallback path instead — erase the screen *and the
// scrollback*, reprint every static row it has ever emitted, then draw the frame
// — and it keeps taking that path on every single render for as long as the
// frame is oversized (see `shouldClearTerminalForFrame` in ink/build/ink.js).
//
// None of the symptoms look like a height problem from the outside. A spinner
// ticking at 80ms turns the fallback into a dozen full-screen repaints a second,
// which reads as the terminal strobing; the scrollback is wiped faster than it
// can be scrolled; and each reprint of the static transcript stamps rows out a
// second time. So the rule the whole module exists to enforce is: the non-static
// region stays *shorter* than the terminal.
//
// The counting lives in one place because every instance of this bug so far has
// been two blocks that each fit perfectly well on their own.

// ── width ─────────────────────────────────────────────────────────────────────

/**
 * Columns held back on the right, so nothing ever reaches the terminal's edge.
 *
 * This is the width half of the same bug. Ink erases by counting `\n`-separated
 * lines and rewinding the cursor that many *physical* rows, and the two agree
 * only while every line fits. A line one column too wide is wrapped by the
 * terminal into two rows, the rewind comes up one short, and the top row of the
 * frame survives — which is duplicated output, one row per frame, exactly as
 * reported.
 *
 * A line that *exactly* fills the width is the same hazard for a subtler reason:
 * it leaves the cursor in the deferred-wrap state, where whether it costs one
 * row or two is up to the terminal. Ink's own source calls this out for Windows
 * consoles (see `shouldClearTerminalForFrame`), and it is not worth relying on
 * elsewhere either.
 *
 * Measured rather than assumed: unconstrained, the assistant row renders a
 * 102-column line into a 100-column terminal, plus three lines sitting exactly
 * on the edge. Two columns of gutter removes all four.
 */
export const SAFE_GUTTER = 2;

/**
 * The width the whole app renders into — apply it to the root box.
 *
 * Applied at the root *and* to each `<Static>` row, which is not redundant:
 * static items are laid out in their own pass and do not inherit the root's
 * width. The committed transcript is where the over-wide line was actually
 * measured, so a root-only constraint fixes the live region and leaves the bug
 * exactly where it was.
 */
export function safeWidth(columns: number): number {
  return Math.max(20, columns - SAFE_GUTTER);
}

// ── height ────────────────────────────────────────────────────────────────────

/** `ActivityStatus`: one row of top margin, one row of text. */
export const STATUS_ROWS = 2;

/** `InputPrompt`: top margin, border, the input line, border, the hint. */
export const PROMPT_ROWS = 5;

/**
 * Rows held back from every budget.
 *
 * Ink counts a frame that merely *equals* the viewport as oversized, and the
 * constants above are lower bounds — a hint that wraps, or an input that has
 * grown to two lines, each costs another row.
 */
export const SLACK = 2;

/**
 * The smallest panel worth drawing: its own chrome plus a couple of rows of the
 * thing being approved. Below this the terminal simply cannot hold an approval
 * prompt, and there is no arrangement of the rows that would change that.
 */
export const MIN_PANEL_ROWS = 16;

/**
 * The shortest terminal an approval prompt actually fits in.
 *
 * Stated rather than pretended away. Below this the panel's own chrome plus the
 * status row exceeds the viewport no matter how the rows are divided, and Ink
 * falls back to clearing the terminal each frame. The tests assert the "stays
 * inside the viewport" property from here upwards, and it genuinely does not
 * hold below — a two-line terminal cannot show a diff and three choices.
 */
export const MIN_TERMINAL_ROWS = 20;

export interface PanelLayout {
  /** Rows the panel may occupy in total, including its border and margins. */
  rows: number;
  /**
   * Whether the input still fits underneath. Typing while an approval is up
   * queues a prompt rather than answering it, so it is a convenience — and the
   * first thing to give up when the terminal cannot hold both.
   */
  showPrompt: boolean;
}

/**
 * Divide the viewport between a modal panel (approval, question) and the rows
 * that render underneath it.
 *
 * The panel is served first: it is the thing the user has to answer.
 */
export function panelLayout(viewportRows: number): PanelLayout {
  const withPrompt = viewportRows - STATUS_ROWS - PROMPT_ROWS - SLACK;
  if (withPrompt >= MIN_PANEL_ROWS) return { rows: withPrompt, showPrompt: true };
  return { rows: Math.max(MIN_PANEL_ROWS, viewportRows - STATUS_ROWS - SLACK), showPrompt: false };
}

/**
 * Columns available inside a panel's border: one column of border and one of
 * padding on each side, inside the root's own gutter.
 *
 * Panels truncate to this rather than letting Ink wrap, because a budget in rows
 * is only enforceable while one line renders as exactly one row. Derived from
 * `safeWidth` rather than from `columns` so the two cannot drift — a panel that
 * thinks it has more room than the root allows would wrap after all, and the row
 * budget would be wrong in the one direction that matters.
 */
export function panelWidth(columns: number): number {
  return Math.max(20, safeWidth(columns) - 4);
}
