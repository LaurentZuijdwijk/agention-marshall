import React from 'react';
import { Box, Text } from 'ink';
import { C, G } from './theme.js';
import { clampToRows, reflowProse } from '../format.js';
import { safeWidth } from './layout.js';

/**
 * Everything in the non-static region besides the prompt: the reasoning buffer
 * and the streaming answer, both of which are redrawn on every token.
 *
 * The height budget is the whole point of this component. Ink redraws the live
 * region in place, so once it grows past the terminal it starts scrolling — and
 * a scrolled frame makes Ink's line-count erase wrong, which shows up as a
 * repaint storm. Both blocks are therefore clamped to a shared budget.
 */

/** Rows the rest of the non-static region needs: the prompt frame (margin +
 *  border + line + border), its hint, and the assistant row's gutter and margin. */
const STREAM_RESERVE_ROWS = 10;

/**
 * Wrapping width for the live text, given the terminal's columns: the root's
 * own gutter, then two more for the `◆ ` in the left column.
 *
 * It has to match what Ink will actually do, not merely be conservative. This
 * width is what `clampToRows` counts rows with, so a width wider than reality
 * under-counts them, and the block quietly overruns the budget that keeps the
 * live region inside the viewport.
 */
export function liveWidth(columns: number): number {
  return Math.max(20, safeWidth(columns) - 2);
}

/**
 * How many rows each live block may use.
 *
 * Both share one budget — separately they each fit, together they overflow, and
 * overflow is what triggers the repaint storm. Exported so the arithmetic can be
 * checked at sizes that are painful to reproduce by hand.
 */
export function splitLiveRows(rows: number, both: boolean): { stream: number; reasoning: number } {
  const budget = Math.max(3, rows - STREAM_RESERVE_ROWS);
  if (!both) return { stream: budget, reasoning: budget };
  const stream = Math.max(2, Math.ceil(budget / 2));
  return { stream, reasoning: Math.max(2, budget - stream) };
}

export function LiveOutput({ stream, reasoning, columns, rows }: {
  stream: string;
  reasoning: string;
  columns: number;
  rows: number;
}) {
  if (stream === '' && reasoning === '') return null;

  const width = liveWidth(columns);
  // The reasoning block has no `◆ ` gutter, so it gets the two columns back
  // that `liveWidth` holds for the stream's. Measuring it two columns narrower
  // than the box it renders into would budget rows against a width Ink is not
  // using, which is the one thing this arithmetic must not do.
  const reasoningWidth = safeWidth(columns);
  const budget = splitLiveRows(rows, stream !== '' && reasoning !== '');
  const streamRows = budget.stream;
  const reasoningRows = budget.reasoning;

  return (
    <>
      {/* Reasoning above the answer, because that is the order the model produced
          them in — and it is what lands in <Static> when the turn completes. */}
      {reasoning !== '' && (
        <Box marginBottom={1}>
          <Text color={C.thinking} italic>{clampToRows(reflowProse(reasoning), reasoningWidth, reasoningRows)}</Text>
        </Box>
      )}

      {/* Live preview only — the finished response is pushed into <Static>, with
          markdown, when the 'response' event lands. Deliberately *not* markdown
          here: clampToRows budgets height by wrapping the raw text, so plain
          <Text> at the same width renders exactly that many rows. Markdown does
          not preserve that relationship (measured: it reflows to a different
          height than its source), so the budget would be unenforceable. */}
      {stream !== '' && (
        <Box marginBottom={1}>
          <Text color={C.accent}>{G.assistant} </Text>
          <Box flexDirection="column" flexGrow={1}>
            <Text color={C.output}>{clampToRows(stream, width, streamRows)}</Text>
          </Box>
        </Box>
      )}
    </>
  );
}
