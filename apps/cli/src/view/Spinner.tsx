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
 *
 * `animate` is a correctness switch, not a preference. Each frame is a render of
 * the entire non-static region, so an oversized frame turns this 80ms tick into
 * a dozen full-screen repaints a second (see view/layout.ts). Stopping it while
 * the agent is blocked on the user is also the truthful reading: nothing is
 * progressing, and the elapsed clock should not claim otherwise.
 */
export function Spinner({ label, inline = false, animate = true }: {
  label?: string;
  inline?: boolean;
  animate?: boolean;
}) {
  const [frame, setFrame] = useState(0);
  const [startedAt] = useState(() => Date.now());

  useEffect(() => {
    if (!animate) return;
    const id = setInterval(() => setFrame(f => f + 1), FRAME_MS);
    return () => clearInterval(id);
  }, [animate]);

  // Ping-pong along the gradient so the spinner pulses rather than jumping.
  const phase = (frame % 40) / 20;
  const color = brand(phase > 1 ? 2 - phase : phase);

  const elapsed = (Date.now() - startedAt) / 1000;
  const verb = label ?? VERBS[Math.min(Math.floor(frame / VERB_FRAMES), VERBS.length - 1)];

  return (
    <Box>
      {/* A frozen braille frame reads as a hang, so a stopped spinner gets the
          "waiting on something else" glyph instead. */}
      <Text color={color}>{animate ? SPINNER_FRAMES[frame % SPINNER_FRAMES.length] : G.pending} </Text>
      <Text color={C.accent}>{verb}</Text>
      <Text color={C.faint}>  {elapsed.toFixed(1)}s</Text>
      {!inline && <Text color={C.faint}>  {G.bullet}  esc to interrupt</Text>}
    </Box>
  );
}
