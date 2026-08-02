import React from 'react';
import { Box, Text } from 'ink';
import { C } from './theme.js';

/** The bordered box at the bottom — holds either the input or the busy spinner. */
export function PromptFrame({ color, hint, children }: {
  color: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box borderStyle="round" borderColor={color} paddingX={1}>
        {children}
      </Box>
      <Box paddingX={2}>
        <Text color={C.faint}>{hint}</Text>
      </Box>
    </Box>
  );
}
