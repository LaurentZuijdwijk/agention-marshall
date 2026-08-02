// ── redraw everything when the terminal resizes ───────────────────────────────
//
// Ink erases by counting the lines it wrote and moving the cursor up that many
// rows. A resize reflows what is already on screen *before* any handler runs, so
// that count is stale and the erase lands in the wrong place — leaving a ladder
// of half-drawn prompt borders. No line-count erase can be correct here, which
// is why this bug is endemic to Ink-based TUIs. Ink's own `resized` only clears
// on narrowing, and even that under-erases once the frame has reflowed.
//
// So: wipe the screen outright and rebuild it. `clear()` first so Ink's cursor
// bookkeeping is reset to zero lines (otherwise its next render moves the cursor
// up into freshly drawn output), then the wipe, then a transcript replay driven
// by remounting <Static>.

const CLEAR_SCREEN_AND_SCROLLBACK = '\u001B[2J\u001B[3J\u001B[H';

/**
 * Both callbacks are read at fire time, not at install time: the Ink instance
 * does not exist until after `render`, and the replay function arrives later
 * still, from the App.
 *
 * Debounced because a drag emits a resize per frame, and each replay reprints
 * the whole session.
 */
export function installResizeRedraw(
  ink: () => { clear: () => void } | undefined,
  replay: () => void,
  delayMs = 120,
): void {
  let timer: NodeJS.Timeout | undefined;

  process.stdout.on('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      ink()?.clear();
      process.stdout.write(CLEAR_SCREEN_AND_SCROLLBACK);
      replay();
    }, delayMs);
  });
}
