import React from 'react';
import { Box, Text } from 'ink';
import { Markdown } from './Markdown.js';
import { C, G } from './theme.js';

/**
 * Assistant prose: a brand diamond in the gutter, markdown-rendered body. The
 * body sits in its own column so wrapped lines hang under the first character
 * rather than under the diamond.
 */
export function AssistantText({ text }: { text: string }) {
  return (
    <Box marginBottom={1}>
      <Text color={C.accent}>{G.assistant} </Text>
      <Box flexDirection="column" flexGrow={1}>
        <Markdown text={text} />
      </Box>
    </Box>
  );
}
