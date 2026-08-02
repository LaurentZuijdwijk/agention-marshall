import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ApprovalRequest, ApprovalDecision } from '@agentionai/marshall-tools';
import { C, G } from './theme.js';

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

const DETAIL_LINES = 20;

export function ApprovalPanel({ request, pending, onSelect }: {
  request: ApprovalRequest;
  pending: number;
  onSelect: (d: ApprovalDecision) => void;
}) {
  const lines = request.detail.split('\n');
  const overflow = lines.length - DETAIL_LINES;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={C.warn} paddingX={1} marginY={1}>
      <Box>
        <Text color={C.warn} bold>{G.warn} approval required</Text>
        {pending > 1 && <Text color={C.faint}>  {pending} queued</Text>}
      </Box>

      <Box marginTop={1}>
        <Text color={C.tool} bold>{request.toolName}</Text>
        <Text color={C.muted}>  {request.description}</Text>
      </Box>

      {/* Whose action this is. With work fanned out across tiers, "approve this
          edit" is a different question depending on which agent — and which
          model — is asking for it. */}
      {request.caller && (
        <Box>
          <Text color={C.faint}>
            requested by {request.caller.role} {G.bullet} {request.caller.model}
          </Text>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        {lines.slice(0, DETAIL_LINES).map((line, i) => (
          <Text key={i} color={detailColor(line)}>{line}</Text>
        ))}
        {overflow > 0 && <Text color={C.faint}>… {overflow} more lines</Text>}
      </Box>

      <ApprovalSelect onSelect={onSelect} />
    </Box>
  );
}
