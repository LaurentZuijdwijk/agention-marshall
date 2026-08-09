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
      <Box marginTop={1}>
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
 * margin and border, the header, the description and its margin, the detail
 * block's margin, and the six the select costs (margin, three options, margin,
 * hint).
 *
 * Counted rather than measured because the budget has to be known *before* the
 * frame is rendered — see view/layout.ts for why it has to be known at all.
 */
export const APPROVAL_CHROME_ROWS = 14;

/**
 * The slice of the detail worth showing, given the rows available.
 *
 * The head, not the tail: a diff or a command reads from the top, and the first
 * line is the one that says what this is. When it does not all fit, one row goes
 * to saying so — silently showing two thirds of a diff is the one outcome an
 * approval prompt cannot afford.
 */
export function detailWindow(lines: string[], budget: number): { shown: string[]; hidden: number } {
  // No budget means no room to say there is more either. Reporting `hidden` here
  // would render the notice as a row outside the budget, which is the whole
  // thing being avoided — a panel one row taller than it promised is a frame one
  // row taller than the viewport. Only reachable on a terminal already too short
  // to show an approval; see MIN_TERMINAL_ROWS.
  if (budget <= 0) return { shown: [], hidden: 0 };
  if (lines.length <= budget) return { shown: lines, hidden: 0 };
  const shown = lines.slice(0, budget - 1);
  return { shown, hidden: lines.length - shown.length };
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
  const { shown, hidden } = detailWindow(request.detail.split('\n'), rows - chrome);

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
      <Box marginTop={1}>
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
        {shown.map((line, i) => (
          <Text key={i} color={detailColor(line)}>{truncate(line, width)}</Text>
        ))}
        {hidden > 0 && <Text color={C.faint}>… {hidden} more lines</Text>}
      </Box>

      <ApprovalSelect onSelect={onSelect} />
    </Box>
  );
}
