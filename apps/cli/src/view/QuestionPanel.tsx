import React, { useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from './TextInput.js';
import type { AskRequest } from '@agentionai/marshall-tools';
import { C, G } from './theme.js';

export function QuestionPanel({ request, pending, onAnswer, onCancel }: {
  request: AskRequest; pending: number; onAnswer: (answer: string) => void; onCancel: () => void;
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
  return <Box flexDirection="column" borderStyle="round" borderColor={C.accent} paddingX={1} marginY={1}>
    <Text color={C.accent} bold>{G.prompt} {request.question}{pending > 1 ? `  (${pending} queued)` : ''}</Text>
    {free ? <TextInput value={freeValue} onChange={setFreeValue} onSubmit={onAnswer} /> : options.map((option, i) => <Text key={i} color={i === cursor ? C.accent : C.muted} bold={i === cursor}>{i === cursor ? `${G.prompt} ` : '  '}{i + 1}. {option}{request.multiSelect && selected.includes(i) ? ' ✓' : ''}</Text>)}
    <Text color={C.faint}>↑↓ move · enter select · esc cancel</Text>
  </Box>;
}
