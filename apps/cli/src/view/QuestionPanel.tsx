import React, { useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from './TextInput.js';
import type { AskRequest } from '@agentionai/marshall-tools';
import { C, G } from './theme.js';
import { truncate, windowRange } from '../format.js';
import { panelWidth } from './layout.js';

/** Margin, border, the question, the hint, border, margin. */
const QUESTION_CHROME_ROWS = 6;

export function QuestionPanel({ request, pending, columns, rows, onAnswer, onCancel }: {
  request: AskRequest;
  pending: number;
  /** Terminal width, so an option too long to fit is cut to one row. */
  columns: number;
  /** Rows this panel may occupy in total — see panelLayout. */
  rows: number;
  onAnswer: (answer: string) => void;
  onCancel: () => void;
}) {
  const options = [...(request.options ?? []), ...(request.allowFreeText ? ['Other…'] : [])];
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<number[]>([]);
  const [free, setFree] = useState(false);
  const [freeValue, setFreeValue] = useState('');
  // Queued follow-ups reuse this mounted instance, so reset all state per question.
  const seen = useRef<AskRequest | null>(null);
  if (seen.current !== request) {
    seen.current = request;
    setCursor(0); setSelected([]); setFree(false); setFreeValue('');
  }
  useInput((ch, key) => {
    if (key.escape) { onCancel(); return; }
    if (free) return;
    if (key.upArrow) setCursor(c => (c - 1 + options.length) % options.length);
    if (key.downArrow) setCursor(c => (c + 1) % options.length);
    if (ch >= '1' && ch <= '9' && Number(ch) <= options.length) setCursor(Number(ch) - 1);
    if (ch === ' ' && request.multiSelect && options.length) setSelected(s => s.includes(cursor) ? s.filter(i => i !== cursor) : [...s, cursor]);
    if (key.return && options.length) {
      if (request.allowFreeText && cursor === options.length - 1) setFree(true);
      else onAnswer(request.multiSelect ? selected.concat(selected.includes(cursor) ? [] : [cursor]).sort().map(i => options[i]).join(', ') : options[cursor]);
    }
  });
  // One row per option, and only as many as the terminal has room for — the
  // panel has to stay shorter than the viewport (see view/layout.ts). The window
  // follows the cursor, so an option off the end is still reachable by arrowing
  // to it.
  const width = panelWidth(columns);
  const { start, end } = windowRange(options.length, cursor, Math.max(1, rows - QUESTION_CHROME_ROWS));
  return <Box flexDirection="column" borderStyle="round" borderColor={C.accent} paddingX={1} marginY={1}>
    <Text color={C.accent} bold>{truncate(`${G.prompt} ${request.question}${pending > 1 ? `  (${pending} queued)` : ''}`, width)}</Text>
    {free ? <TextInput value={freeValue} onChange={setFreeValue} onSubmit={onAnswer} /> : options.slice(start, end).map((option, i) => { const index = start + i; return <Text key={index} color={index === cursor ? C.accent : C.muted} bold={index === cursor}>{truncate(`${index === cursor ? `${G.prompt} ` : '  '}${index + 1}. ${option}${request.multiSelect && selected.includes(index) ? ' ✓' : ''}`, width)}</Text>; })}
    <Text color={C.faint}>↑↓ move · enter select · esc cancel</Text>
  </Box>;
}
