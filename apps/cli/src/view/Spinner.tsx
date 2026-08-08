import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { C, G, SPINNER_FRAMES, brand } from './theme.js';

const FRAME_MS = 80;

/** Rotates so a long task doesn't look like a hung one. */
const VERBS = ['thinking', 'reading', 'reasoning', 'working', 'digging in', 'still on it'];
const VERB_FRAMES = Math.round(4_000 / FRAME_MS);

/**
 * The "agent is busy" indicator: a braille spinner whose colour rides the brand
 * gradient, the elapsed time, and a rotating status verb.
 */
export function Spinner({ label, inline = false }: { label?: string; inline?: boolean }) {
  const [frame, setFrame] = useState(0);
  const [startedAt] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setFrame(f => f + 1), FRAME_MS);
    return () => clearInterval(id);
  }, []);

  // Ping-pong along the gradient so the spinner pulses rather than jumping.
  const phase = (frame % 40) / 20;
  const color = brand(phase > 1 ? 2 - phase : phase);

  const elapsed = (Date.now() - startedAt) / 1000;
  const verb = label ?? VERBS[Math.min(Math.floor(frame / VERB_FRAMES), VERBS.length - 1)];

  return (
    <Box>
      <Text color={color}>{SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} </Text>
      <Text color={C.accent}>{verb}</Text>
      <Text color={C.faint}>  {elapsed.toFixed(1)}s</Text>
      {!inline && <Text color={C.faint}>  {G.bullet}  esc to interrupt</Text>}
    </Box>
  );
}
