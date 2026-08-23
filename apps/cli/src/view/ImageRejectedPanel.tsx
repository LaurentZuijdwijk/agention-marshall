import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { C, G } from './theme.js';
import { truncate } from '../format.js';
import { panelWidth } from './layout.js';

export type ImageRejectedChoice = 'retry' | 'model';

const OPTIONS: Array<{ label: string; hint: string; value: ImageRejectedChoice }> = [
  { label: 'Remove the image and retry', hint: 'r', value: 'retry' },
  { label: 'Change model',               hint: 'm', value: 'model' },
];

/**
 * Shown when a provider rejects a turn specifically because of an attached
 * image — a local model with no vision support, most often. The raw provider
 * message is already in the transcript above this (see the `image-rejected`
 * case in useEngineClient.ts); this panel is only the two ways forward.
 */
export function ImageRejectedPanel({ columns, onSelect, onCancel }: {
  columns: number;
  onSelect: (choice: ImageRejectedChoice) => void;
  onCancel: () => void;
}) {
  const width = panelWidth(columns);
  const [cursor, setCursor] = useState(0);

  useInput((ch, key) => {
    if (key.escape) { onCancel(); return; }
    if (key.upArrow)   { setCursor(c => (c - 1 + OPTIONS.length) % OPTIONS.length); return; }
    if (key.downArrow) { setCursor(c => (c + 1) % OPTIONS.length); return; }
    if (key.return)    { onSelect(OPTIONS[cursor].value); return; }
    if (ch === 'r')     { onSelect('retry'); return; }
    if (ch === 'm')     { onSelect('model'); return; }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={C.warn} paddingX={1} marginY={1}>
      <Text color={C.warn} bold>{truncate(`${G.warn} this model could not read the attached image`, width)}</Text>
      <Box marginTop={1} flexDirection="column">
        {OPTIONS.map((opt, i) => {
          const active = i === cursor;
          return (
            <Box key={opt.value}>
              <Text color={active ? C.accent : C.faint} bold={active}>
                {active ? `${G.prompt} ` : '  '}
              </Text>
              <Text color={active ? C.accent : C.muted} bold={active}>
                {opt.label.padEnd(28)}
              </Text>
              <Text color={C.faint}>{opt.hint}</Text>
            </Box>
          );
        })}
      </Box>
      <Text color={C.faint}>↑↓ move {G.bullet} enter select {G.bullet} esc dismiss</Text>
    </Box>
  );
}
