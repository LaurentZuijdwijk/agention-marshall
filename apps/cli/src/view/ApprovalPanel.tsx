import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ApprovalRequest, ApprovalDecision } from '@agentionai/marshall-tools';
import { C, G } from './theme.js';
import { truncate } from '../format.js';
import { panelWidth } from './layout.js';

// ── approval select ────────────────────────────────────────────────────────────

const APPROVAL_OPTIONS: Array<{ label: string; hint: string; value: ApprovalDecision; color: string }> = [
  { label: 'Approve',                  hint: 'y', value: 'approve', color: C.ok    },
  { label: 'Always approve this tool', hint: 'a', value: 'always',  color: C.ok    },
  { label: 'Deny',                     hint: 'n', value: 'deny',    color: C.error },
];

export function ApprovalSelect({ onSelect }: { onSelect: (d: ApprovalDecision) => void }) {
  const [cursor, setCursor] = useState(0);

  useInput((ch, key) => {
    if (key.upArrow)   { setCursor(c => (c - 1 + APPROVAL_OPTIONS.length) % APPROVAL_OPTIONS.length); return; }
    if (key.downArrow) { setCursor(c => (c + 1) % APPROVAL_OPTIONS.length); return; }
    if (key.return)    { onSelect(APPROVAL_OPTIONS[cursor].value); return; }
    // Quick single-key shortcuts
    if (ch === 'y')    { onSelect('approve'); return; }
    if (ch === 'a')    { onSelect('always');  return; }
    if (ch === 'n')    { onSelect('deny');    return; }
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      {APPROVAL_OPTIONS.map((opt, i) => {
        const active = i === cursor;
        return (
          <Box key={opt.value}>
            <Text color={active ? opt.color : C.faint} bold={active}>
              {active ? `${G.prompt} ` : '  '}
            </Text>
            <Text color={active ? opt.color : C.muted} bold={active}>
              {opt.label.padEnd(26)}
            </Text>
            <Text color={C.faint}>{opt.hint}</Text>
          </Box>
        );
      })}
      <Box>
        <Text color={C.faint}>
          ↑↓ move {G.bullet} enter select {G.bullet} esc deny all and interrupt
        </Text>
      </Box>
    </Box>
  );
}

/** The transcript line left behind once a decision is made. */
export const APPROVAL_LABELS: Record<ApprovalDecision, string> = {
  approve: `${G.ok} approved`,
  always:  `${G.ok} approved (always)`,
  deny:    `${G.no} denied`,
};

// ── approval panel ─────────────────────────────────────────────────────────────

/** Colour unified-diff and shell output so the proposed change reads at a glance. */
function detailColor(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return C.muted;
  if (line.startsWith('@@'))  return C.accent;
  if (line.startsWith('+'))   return C.ok;
  if (line.startsWith('-'))   return C.error;
  return C.muted;
}

/**
 * Rows the panel spends on everything that is not the detail block: its own
 * margin and border, the header, the description, the detail block's margin,
 * and the five the select costs (margin, three options, hint).
 *
 * The blank rows that survive are the ones between blocks — header, detail,
 * choices. The two that used to sit *inside* a block (under the header, above
 * the select's hint) bought nothing: on a short terminal they were rows taken
 * straight out of the diff, which is the only part of this panel anyone needs
 * to read.
 *
 * Counted rather than measured because the budget has to be known *before* the
 * frame is rendered — see view/layout.ts for why it has to be known at all.
 */
export const APPROVAL_CHROME_ROWS = 12;

/**
 * The detail split into rows, and whether it is a file diff.
 *
 * The `--- path` / `+++ path` pair that formatFileDiff opens with (see
 * tools/primitives/diff.ts) is dropped: the description one row above already
 * names the file, and on a short terminal those two rows were routinely half of
 * everything the user got to see. Stripped here rather than in the primitive
 * because the same string goes to the automated reviewer at safety level 3,
 * which has no description row to fall back on.
 */
export function detailRows(detail: string): { lines: string[]; isDiff: boolean } {
  const lines = detail.split('\n');
  const isDiff = lines.length >= 2 && lines[0].startsWith('--- ') && lines[1].startsWith('+++ ');
  return { lines: isDiff ? lines.slice(2) : lines, isDiff };
}

/** Unchanged lines kept above the first change when a diff has to be windowed. */
const LEAD_CONTEXT = 1;

/** Index of the first added or removed line, or 0 if there is none. */
function firstChange(lines: string[]): number {
  const index = lines.findIndex(line => line.startsWith('+') || line.startsWith('-'));
  return index < 0 ? 0 : index;
}

/**
 * The slice of the detail worth showing, given the rows available.
 *
 * Whatever is cut, one row goes to saying so: silently showing two thirds of a
 * diff is the one outcome an approval prompt cannot afford.
 *
 * A diff is windowed around its first change rather than from the top.
 * formatFileDiff keeps CONTEXT_LINES either side of every change, so up to three
 * unchanged lines — and the `@@` marker before them — can precede the first real
 * one, which on a small budget is the difference between seeing the change and
 * seeing only the code around it. Anything that is not a diff still reads from
 * the top, and has to: in a shell command a leading `-` is a flag, not a change,
 * and the first word is the part that says what will run.
 */
export function detailWindow(lines: string[], budget: number, isDiff = false): {
  shown: string[];
  hidden: number;
  skipped: number;
} {
  // No budget means no room to say there is more either. Reporting `hidden` here
  // would render the notice as a row outside the budget, which is the whole
  // thing being avoided — a panel one row taller than it promised is a frame one
  // row taller than the viewport. Only reachable on a terminal already too short
  // to show an approval; see MIN_TERMINAL_ROWS.
  if (budget <= 0) return { shown: [], hidden: 0, skipped: 0 };
  if (lines.length <= budget) return { shown: lines, hidden: 0, skipped: 0 };

  // Anchoring costs a row to report what it skipped, so it only pays while the
  // budget still has room for more content than that row takes back.
  const anchor = isDiff ? Math.max(0, firstChange(lines) - LEAD_CONTEXT) : 0;
  const start = anchor > 0 && budget >= LEAD_CONTEXT + 3 ? anchor : 0;
  const rest = lines.slice(start);
  const notice = start > 0 ? 1 : 0;

  if (rest.length <= budget - notice) {
    // The tail fits with rows to spare, so spend them going back up rather than
    // leaving the panel short of the budget it was given. Reaching the first
    // line frees the notice's own row too, which is why the bound is recomputed
    // each step instead of being subtracted once.
    let from = start;
    while (from > 0 && lines.length - (from - 1) + (from > 1 ? 1 : 0) <= budget) from--;
    return { shown: lines.slice(from), hidden: 0, skipped: from };
  }
  const shown = rest.slice(0, budget - notice - 1);
  return { shown, hidden: rest.length - shown.length, skipped: start };
}

export function ApprovalPanel({ request, pending, columns, rows, onSelect }: {
  request: ApprovalRequest;
  pending: number;
  /** Terminal width, so every line can be cut to exactly one row. */
  columns: number;
  /** Rows this panel may occupy in total — see panelLayout. */
  rows: number;
  onSelect: (d: ApprovalDecision) => void;
}) {
  const width = panelWidth(columns);
  // The two optional provenance rows are part of the chrome when they render.
  const chrome = APPROVAL_CHROME_ROWS
    + (request.source?.kind === 'mcp' ? 1 : 0)
    + (request.caller ? 1 : 0);
  const { lines, isDiff } = detailRows(request.detail);
  const { shown, hidden, skipped } = detailWindow(lines, rows - chrome, isDiff);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={C.warn} paddingX={1} marginY={1}>
      <Box>
        <Text color={C.warn} bold>{G.warn} approval required</Text>
        {pending > 1 && <Text color={C.faint}>  {pending} queued</Text>}
      </Box>

      {/* Everything below is cut to one row rather than wrapped. A row budget
          only holds while one line renders as one row, and the strings here are
          shell commands, diff hunks and MCP-supplied text — all of them
          routinely wider than the terminal. */}
      <Box>
        <Text color={C.tool} bold>{truncate(request.description, width)}</Text>
      </Box>

      {/* Provenance, and the only warning the user gets. A builtin tool is code
          in this repo; an MCP tool is a remote party's, and that party also
          wrote the name and description shown above — so the one thing worth
          stating outright is that none of this text is ours. */}
      {request.source?.kind === 'mcp' && (
        <Box>
          <Text color={C.warn}>
            {truncate(`${G.warn} remote tool from the ${request.source.server} MCP server`, width)}
          </Text>
        </Box>
      )}

      {/* Whose action this is. With work fanned out across tiers, "approve this
          edit" is a different question depending on which agent — and which
          model — is asking for it. */}
      {request.caller && (
        <Box>
          <Text color={C.faint}>
            {truncate(`requested by ${request.caller.id ?? request.caller.role} ${G.bullet} ${request.caller.model}`, width)}
          </Text>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        {skipped > 0 && <Text color={C.faint}>… {skipped} earlier lines</Text>}
        {shown.map((line, i) => (
          <Text key={i} color={detailColor(line)}>{truncate(line, width)}</Text>
        ))}
        {hidden > 0 && <Text color={C.faint}>… {hidden} more lines</Text>}
      </Box>

      <ApprovalSelect onSelect={onSelect} />
    </Box>
  );
}
