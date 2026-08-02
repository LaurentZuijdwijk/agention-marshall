import React from 'react';
import { Box, Text } from 'ink';
import { C, G } from './theme.js';
import { PromptFrame } from './PromptFrame.js';
import { TextInput } from './TextInput.js';

/**
 * What the prompt is for right now. Colour, glyph, hint and placeholder all move
 * together, so they are picked from one flag rather than three conditionals
 * spread across the render.
 */
export type PromptKind = 'task' | 'steering' | 'login';

const PROMPTS: Record<PromptKind, {
  color: string; glyph: string; hint: string; placeholder: string;
}> = {
  task: {
    color: C.brandFrom,
    glyph: G.prompt,
    hint: `tab completes ${G.bullet} enter sends ${G.bullet} esc esc quits`,
    placeholder: 'type a task, or / for commands…',
  },
  steering: {
    color: C.warn,
    glyph: G.steer,
    hint: `steering ${G.bullet} your next message course-corrects the agent`,
    placeholder: 'steer the agent…',
  },
  login: {
    color: C.warn,
    glyph: G.pending,
    hint: 'paste the code from your browser, then enter',
    placeholder: 'paste code here…',
  },
};

export function InputPrompt({ kind, value, ghost, onPaste, onChange, onSubmit }: {
  kind: PromptKind;
  value: string;
  /** Completion of the slash command being typed, shown dimmed after the cursor. */
  ghost: string;
  /** Rewrites pasted text before it is inserted — see usePasteBuffer. */
  onPaste?: (text: string) => string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
}) {
  const { color, glyph, hint, placeholder } = PROMPTS[kind];

  return (
    <PromptFrame color={color} hint={hint}>
      {/* A pasted value can be several lines, so the glyph sits in its own
          column rather than sharing a line box with the text. */}
      <Box>
        <Text color={color} bold>{glyph} </Text>
        <Box flexDirection="column" flexGrow={1}>
          <Text>
            <TextInput
              value={value}
              onPaste={onPaste}
              onChange={onChange}
              onSubmit={onSubmit}
              placeholder={placeholder}
            />
            {ghost && <Text color={C.faint}>{ghost}</Text>}
          </Text>
        </Box>
      </Box>
    </PromptFrame>
  );
}
