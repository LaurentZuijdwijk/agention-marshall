// ── wizard chrome ─────────────────────────────────────────────────────────────
//
// The frame every setup screen shares: the wordmark header, the one-line hint
// under a control, and the escapable text field. Extracted so the wizard's step
// machine and the model picker can both use them without importing each other.

import React from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from './TextInput.js';
import { C, G, brand } from './theme.js';
import { traceRender } from '../renderTrace.js';

const WORDMARK = 'marshall';

/** Gradient wordmark plus the current step, shared by every wizard screen. */
export function Title({ step }: { step: string }) {
  traceRender('Title', step.slice(0, 30));
  return (
    <Box>
      <Box flexShrink={0}>
        <Text>
          {[...WORDMARK].map((ch, i) => (
            <Text key={i} bold color={brand(i / (WORDMARK.length - 1))}>{ch}</Text>
          ))}
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Text color={C.faint}>  {G.bullet}  </Text>
      </Box>
      <Box flexGrow={1} minWidth={8}>
        <Text color={C.muted} wrap="truncate-end">{step}</Text>
      </Box>
    </Box>
  );
}

export function Hint({ children }: { children: React.ReactNode }) {
  traceRender('Hint');
  // wrap={false}: a hint is one line of chrome, never prose. Letting it wrap
  // means a narrow terminal asks Yoga to measure it at <1 column, which is
  // the state that used to send wrap-ansi into a runaway allocation.
  return <Text color={C.faint} wrap="truncate-end">{children}</Text>;
}

export function BackableTextInput({
  value, onChange, onSubmit, onBack, placeholder, mask,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  onBack: () => void;
  placeholder?: string;
  mask?: string;
}) {
  traceRender('BackableTextInput', `len=${value.length} cols=${process.stdout.columns}`);
  useInput((_, key) => {
    if (key.escape) onBack();
  });

  // The prompt glyph must not compete with the input for space. Without
  // flexShrink={0} on the glyph and a minWidth on the field, flex shrink can
  // drive the input's width to zero — and Ink then asks wrap-ansi to wrap text
  // into zero columns, which never terminates and allocates until the heap
  // dies. Reserving room makes that state unreachable rather than unlikely.
  return (
    <Box paddingX={1} flexDirection="row">
      <Box flexShrink={0}>
        <Text color={C.brandTo} bold>{G.prompt} </Text>
      </Box>
      <Box flexGrow={1} minWidth={16}>
        <TextInput value={value} onChange={onChange} onSubmit={onSubmit} placeholder={placeholder} mask={mask} />
      </Box>
    </Box>
  );
}
