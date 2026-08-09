---
"@agentionai/marshall-cli": patch
---

Keep the rendered frame inside the terminal, in both directions.

Ink erases a frame by rewinding as many rows as its output has lines, which is
only correct while the frame fits. Too tall and Ink clears the terminal —
scrollback included — then reprints the whole static transcript on every render;
with the activity spinner ticking at 80ms that was a dozen full-screen repaints a
second, which read as flicker, unscrollable history and a frozen UI. Too wide and
the terminal wraps a line the rewind never gets back, leaving the top row of the
frame behind — one stale row per frame, which is the same answer printed over and
over.

So: the approval panel is budgeted against `stdout.rows` instead of a fixed
twenty lines of detail and cuts each line to one row; the queue-a-prompt input
steps aside on terminals too short to hold both; the spinner stops animating
while the turn is blocked on you; and nothing renders into the terminal's last
column. The width has to be applied to `<Static>`'s rows individually as well as
to the root, because static items are laid out in their own pass and do not
inherit it — unconstrained, a committed transcript row measured 121 columns wide
in a 120-column terminal.

Approvals need at least 20 rows to fit; below that the panel is degraded by
design rather than silently oversized.
