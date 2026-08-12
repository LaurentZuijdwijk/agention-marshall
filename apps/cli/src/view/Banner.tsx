import React, { useEffect, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { C, G, brand, mix } from './theme.js';
import type { RuntimeMode } from '../services/settings.js';

// ── wordmark ──────────────────────────────────────────────────────────────────

const LOGO_WIDE = [
  '███╗   ███╗ █████╗ ██████╗ ███████╗██╗  ██╗ █████╗ ██╗     ██╗     ',
  '████╗ ████║██╔══██╗██╔══██╗██╔════╝██║  ██║██╔══██╗██║     ██║     ',
  '██╔████╔██║███████║██████╔╝███████╗███████║███████║██║     ██║     ',
  '██║╚██╔╝██║██╔══██║██╔══██╗╚════██║██╔══██║██╔══██║██║     ██║     ',
  '██║ ╚═╝ ██║██║  ██║██║  ██║███████║██║  ██║██║  ██║███████╗███████╗',
  '╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚══════╝',
];

const LOGO_COMPACT = [
  '█▀▄▀█ ▄▀█ █▀█ █▀ █ █ ▄▀█ █   █  ',
  '█ ▀ █ █▀█ █▀▄ ▄█ █▀█ █▀█ █▄▄ █▄▄',
];

/** The wide wordmark needs breathing room; fall back to the half-block one. */
function pickLogo(columns: number): string[] {
  return columns >= LOGO_WIDE[0].length + 2 ? LOGO_WIDE : LOGO_COMPACT;
}

// ── gradient wordmark ─────────────────────────────────────────────────────────

/** Colour bands across the wordmark. More = smoother gradient, more ink nodes. */
const BANDS = 18;

/**
 * The wordmark, painted with the brand gradient.
 *
 * `reveal` (0..1) wipes the logo in from the left — hidden columns are replaced
 * by spaces rather than dropped, so the layout never reflows mid-animation.
 * `sweep` is the column position of a white highlight that rides along the
 * reveal edge and then makes one shimmer pass; put it off-screen for a still.
 */
function Wordmark({ rows, reveal, sweep }: { rows: string[]; reveal: number; sweep: number }) {
  const width = rows[0].length;
  const band = Math.ceil(width / BANDS);
  const shown = Math.round(reveal * width);
  const glowRadius = width * 0.18;

  return (
    <Box flexDirection="column">
      {rows.map((row, r) => (
        <Box key={r}>
          {Array.from({ length: Math.ceil(width / band) }, (_, b) => {
            const start = b * band;
            const seg = row.slice(start, start + band);
            const visible = Math.max(0, Math.min(seg.length, shown - start));
            const masked = seg.slice(0, visible) + ' '.repeat(seg.length - visible);

            const centre = start + seg.length / 2;
            let color = brand(centre / width);
            const distance = Math.abs(centre - sweep);
            if (distance < glowRadius) {
              color = mix(color, '#FFFFFF', 1 - distance / glowRadius);
            }

            return <Text key={b} color={color}>{masked}</Text>;
          })}
        </Box>
      ))}
    </Box>
  );
}

/** Sits under the rule in both the animated banner and the static header —
 *  see the note on `Banner` about the two keeping identical geometry. `dim`
 *  during the reveal, so it settles in with `Meta` rather than arriving whole
 *  while the wordmark is still being written. */
export const STARTUP_TAGLINES = [
  'Build me software, make no mistakes',
  'Build fast. Break nothing.',
  'Ship code. Fear consequences.',
  'No bugs. No excuses.',
  'Deploy boldly. Roll back quietly.',
  'Turn caffeine into infrastructure.',
] as const;

function Tagline({ text, dim }: { text: string; dim?: boolean }) {
  return (
    <Text color={dim ? C.faint : C.muted} italic>{text}</Text>
  );
}

/** Gradient rule under the wordmark; grows with `reveal`. */
function Rule({ width, reveal }: { width: number; reveal: number }) {
  const drawn = Math.round(reveal * width);
  const band = Math.ceil(width / BANDS);

  return (
    <Box>
      {Array.from({ length: Math.ceil(width / band) }, (_, b) => {
        const start = b * band;
        const len = Math.min(band, width - start);
        const visible = Math.max(0, Math.min(len, drawn - start));
        return (
          <Text key={b} color={brand((start + len / 2) / width)}>
            {G.rule.repeat(visible) + ' '.repeat(len - visible)}
          </Text>
        );
      })}
    </Box>
  );
}

// ── session header ────────────────────────────────────────────────────────────

export interface HeaderMeta {
  provider: string;
  model: string;
  dir: string;
  /** Fast-tier model, when one is configured — absent means no tiering. */
  fastModel?: string;
  fastProvider?: string;
  /**
   * The tool-call safety level ('yolo' | 'default' | 'agentic'), shown only
   * when it isn't 'default'. Session-only — see `/safety` — so this is the one
   * place a user rejoining the terminal mid-session can tell it's not the
   * usual human-in-the-loop gate without re-running `/safety`.
   */
  safety?: string;
  /** Startup settings that affect this session. */
  version?: string;
  runtime?: RuntimeMode;
  webSearch?: boolean;
  github?: boolean;
}

/** The key/value block that sits under the wordmark. `keys` is boot-time
 *  orientation, so it is dropped once the user is already oriented. */
function Meta({ meta, dim, showKeys = true }: { meta: HeaderMeta; dim?: boolean; showKeys?: boolean }) {
  const label = (text: string) => (
    <Text color={dim ? C.faint : C.muted}>{text.padEnd(8)}</Text>
  );

  return (
    <Box flexDirection="column">
      <Box>
        {label(meta.fastModel ? 'deep' : 'model')}
        <Text color={dim ? C.faint : C.accent}>{meta.model}</Text>
        <Text color={C.faint}>  {G.bullet}  </Text>
        <Text color={dim ? C.faint : C.muted}>{meta.provider}</Text>
      </Box>
      {meta.fastModel && (
        <Box>
          {label('fast')}
          <Text color={dim ? C.faint : C.user}>{meta.fastModel}</Text>
          <Text color={C.faint}>  {G.bullet}  </Text>
          <Text color={dim ? C.faint : C.muted}>{meta.fastProvider}</Text>
        </Box>
      )}
      <Box>
        {label('dir')}
        <Text color={dim ? C.faint : C.muted}>{meta.dir}</Text>
      </Box>
      {meta.runtime && (
        <Box>
          {label('runtime')}
          <Text color={dim ? C.faint : C.muted}>{meta.runtime}</Text>
        </Box>
      )}
      {meta.safety && (
        <Box>
          {label('safety')}
          <Text color={dim ? C.faint : meta.safety === 'yolo' ? C.error : C.muted}>{meta.safety}</Text>
        </Box>
      )}
      {meta.version && (
        <Box>
          {label('version')}
          <Text color={dim ? C.faint : C.muted}>v{meta.version}</Text>
        </Box>
      )}
      {(meta.webSearch === false || meta.github) && (
        <Box>
          {label('settings')}
          <Text color={dim ? C.faint : C.muted}>
            {[meta.webSearch === false && 'web off', meta.github && 'GitHub on'].filter(Boolean).join('  ·  ')}
          </Text>
        </Box>
      )}
      {showKeys && (
        <Box>
          {label('keys')}
          <Text color={C.faint}>
            /help {G.bullet} tab completes {G.bullet} esc interrupts {G.bullet} esc esc quits
          </Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * The finished header — what stays in the scrollback once boot is over.
 *
 * `compact` drops the wordmark and the key hints, leaving just what changed.
 * Used when the session is rebuilt mid-run (a model switch): Ink's `<Static>`
 * has already written the original banner permanently to the terminal, so
 * re-emitting the full one does not replace it, it prints a second logo
 * underneath the first. The only ways out are to wipe the screen — which is
 * what `/clear` does, and which would throw away the conversation above — or
 * to print something that reads as a continuation. This is that.
 */
export function Header({ meta, columns = process.stdout.columns ?? 80, compact = false, tagline }: {
  meta: HeaderMeta;
  columns?: number;
  compact?: boolean;
  tagline?: string;
}) {
  // Pin the fallback at first render, same as the animated banner below — a
  // re-render must not roll a fresh sentence. Callers hand the session's pick in
  // via `tagline`, so this fallback normally never fires.
  const [effectiveTagline] = useState(
    () => tagline ?? STARTUP_TAGLINES[Math.floor(Math.random() * STARTUP_TAGLINES.length)],
  );
  if (compact) {
    return (
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        <Box>
          <Text color={C.faint}>{G.rule.repeat(3)} </Text>
          <Text color={C.muted}>model changed</Text>
        </Box>
        <Box marginTop={1}><Meta meta={meta} showKeys={false} /></Box>
      </Box>
    );
  }

  const rows = pickLogo(columns);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Wordmark rows={rows} reveal={1} sweep={-9999} />
      <Rule width={rows[0].length} reveal={1} />
      <Tagline text={effectiveTagline} />
      <Box marginTop={1}><Meta meta={meta} /></Box>
    </Box>
  );
}

// ── boot animation ────────────────────────────────────────────────────────────

const FRAME_MS      = 45;
const REVEAL_FRAMES = 16; // light writes the wordmark in
const SHIMMER_FRAMES = 12; // one highlight pass across the finished letters
const TOTAL_FRAMES  = REVEAL_FRAMES + SHIMMER_FRAMES;

/**
 * Startup animation. Renders the same geometry as `<Header>` so that when the
 * final frame is swapped for the static header the wordmark simply locks in
 * place instead of jumping.
 */
export function Banner({ meta, onDone, columns = process.stdout.columns ?? 80, tagline }: {
  meta: HeaderMeta;
  onDone: () => void;
  columns?: number;
  tagline?: string;
}) {
  const rows = pickLogo(columns);
  // Pick once at mount — the banner re-renders every animation frame, and
  // computing this in the render body would draw a new random sentence each
  // frame, flashing through the whole list.
  const [selectedTagline] = useState(
    () => tagline ?? STARTUP_TAGLINES[Math.floor(Math.random() * STARTUP_TAGLINES.length)],
  );
  const width = rows[0].length;

  const [frame, setFrame] = useState(0);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  // Advance one frame at a time and stop scheduling at the end. The updater
  // stays pure — calling onDone() from inside it ran a parent setState during
  // React's render phase, which React warns about and ink's patched console
  // turns into another render, feeding back on itself.
  const finished = frame >= TOTAL_FRAMES;

  useEffect(() => {
    if (finished) return;
    const id = setTimeout(() => setFrame(f => f + 1), FRAME_MS);
    return () => clearTimeout(id);
  }, [frame, finished]);

  useEffect(() => {
    if (finished) onDoneRef.current();
  }, [finished]);

  const revealing = frame < REVEAL_FRAMES;
  const reveal = revealing ? (frame + 1) / REVEAL_FRAMES : 1;
  // While revealing the glow rides the wipe edge; afterwards it runs off the
  // right side and out of view.
  const sweep = revealing
    ? reveal * width
    : width * (0.2 + 1.1 * ((frame - REVEAL_FRAMES) / SHIMMER_FRAMES));

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Wordmark rows={rows} reveal={reveal} sweep={sweep} />
      <Rule width={width} reveal={reveal} />
      <Tagline text={selectedTagline} dim={revealing} />
      <Box marginTop={1}>
        {revealing
          // Keep the block reserved so the header doesn't pop the layout down.
          ? <Meta meta={meta} dim />
          : <Meta meta={meta} />}
      </Box>
    </Box>
  );
}
