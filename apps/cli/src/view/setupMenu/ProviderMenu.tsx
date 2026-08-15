import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { C, G } from '../theme.js';
import { Title, Hint } from '../WizardChrome.js';
import { PROVIDERS } from '../../services/modelCatalog.js';

/**
 * One row: a stored endpoint, identified the same way the config identifies it.
 *
 * No `apiKey`. The menu names endpoints and removes them; it has no business
 * holding the credential, and not having the field is a cheaper guarantee than
 * remembering never to render it.
 */
export type ProviderEntry = { provider: string; name?: string; host?: string; removable?: boolean };

export function ProviderMenu({ providers, onAdd, onRemove, onBack }: {
  providers: ProviderEntry[];
  onAdd: () => void;
  onRemove: (entry: ProviderEntry) => void;
  onBack: () => void;
}) {
  const [cursor, setCursor] = useState(0);
  const builtIn: ProviderEntry[] = PROVIDERS.map(({ value, hint }) => ({ provider: value, host: hint, removable: false }));
  // A stored entry is removable when it is something the user added: a named
  // endpoint, or a provider the built-in list does not already offer. A built-in
  // row is the wizard's entry point, not something with anything to forget.
  const userAdded = providers
    .filter(entry => entry.name || !builtIn.some(item => item.provider === entry.provider))
    .map(entry => ({ ...entry, removable: true }));
  // The trailing "add" row is an index, not a row: giving it a `provider` of its
  // own put a value in that field that was not a provider, so every read of a
  // row had to work out which of the two kinds it was holding first.
  const rows: ProviderEntry[] = [...builtIn, ...userAdded];
  const addRow = rows.length;

  useInput((ch, key) => {
    if (key.upArrow) setCursor(c => (c - 1 + addRow + 1) % (addRow + 1));
    else if (key.downArrow) setCursor(c => (c + 1) % (addRow + 1));
    else if (key.return) {
      if (cursor === addRow) { onAdd(); return; }
      const row = rows[cursor];
      if (row?.removable) onRemove(row);
    } else if (key.escape || key.leftArrow || ch === '\u001b') onBack();
  });

  return <Box flexDirection="column">
    <Title step="providers" />
    <Hint>enter add/remove · ↑↓ navigate · esc back</Hint>
    {rows.map((row, i) => {
      const active = i === cursor;
      return <Box key={`${row.provider}-${row.name ?? ''}`}>
        <Text color={active ? C.brandTo : C.faint} bold={active}>{active ? `${G.prompt} ` : '  '}</Text>
        <Text color={active ? C.brandTo : C.muted} bold={active}>{row.name ?? row.provider}</Text>
        <Text color={C.faint}>  {row.host ?? row.provider}</Text>
      </Box>;
    })}
    <Box>
      <Text color={cursor === addRow ? C.brandTo : C.faint} bold={cursor === addRow}>{cursor === addRow ? `${G.prompt} ` : '  '}</Text>
      <Text color={cursor === addRow ? C.brandTo : C.accent} bold={cursor === addRow}>Add provider</Text>
    </Box>
  </Box>;
}
