import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { McpServerConfig } from '@agentionai/marshall-engine';
import { C, G } from '../theme.js';
import { Title, Hint } from '../WizardChrome.js';

export function McpMenu({ servers, onAdd, onRemove, onBack }: {
  servers: McpServerConfig[];
  onAdd: () => void;
  onRemove: (server: McpServerConfig) => void;
  onBack: () => void;
}) {
  const [cursor, setCursor] = useState(0);
  const count = servers.length + 1; // servers + the "Add server" row
  useInput((ch, key) => {
    if (key.upArrow) setCursor(c => (c - 1 + count) % count);
    else if (key.downArrow) setCursor(c => (c + 1) % count);
    else if (key.return) {
      if (cursor === servers.length) onAdd();
      else onRemove(servers[cursor]!);
    } else if (key.escape || key.leftArrow || ch === '\u001b') onBack();
  });
  return <Box flexDirection="column">
    <Title step="mcp" />
    <Hint>enter remove/add · ↑↓ navigate · esc back</Hint>
    {servers.map((server, i) => {
      const active = i === cursor;
      return <Box key={server.name}>
        <Text color={active ? C.brandTo : C.faint} bold={active}>{active ? `${G.prompt} ` : '  '}</Text>
        <Text color={active ? C.brandTo : C.muted} bold={active}>{server.name}</Text>
        <Text color={C.faint}>  {server.url}</Text>
      </Box>;
    })}
    <Box><Text color={cursor === servers.length ? C.brandTo : C.accent} bold={cursor === servers.length}>{cursor === servers.length ? `${G.prompt} ` : '  '}Add server</Text></Box>
  </Box>;
}
