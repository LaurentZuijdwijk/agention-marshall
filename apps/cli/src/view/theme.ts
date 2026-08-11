// ── theme ─────────────────────────────────────────────────────────────────────
//
// One place for colour and glyphs so the banner, prompt, message rows and setup
// wizard all speak the same visual language. Colours are truecolor hex — chalk
// (via ink) downsamples them automatically on 256/16-colour terminals.

import { execFileSync } from 'node:child_process';

/**
 * Ink has no reliable terminal-background signal. COLORFGBG covers terminals
 * that provide one; on macOS, the system appearance is the best fallback (and
 * is what Terminal.app follows by default).
 */
function prefersLightTerminal(): boolean {
  const colorFgBg = process.env.COLORFGBG;
  if (colorFgBg) {
    const background = Number(colorFgBg.split(';').at(-1));
    if (Number.isFinite(background)) return background >= 7;
  }

  if (process.platform === 'darwin') {
    try {
      execFileSync('defaults', ['read', '-g', 'AppleInterfaceStyle'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return false;
    } catch {
      return true;
    }
  }

  return false;
}

const LIGHT = prefersLightTerminal();

export const C = {
  /** Brand gradient endpoints — violet → cyan. */
  brandFrom: LIGHT ? '#6D28D9' : '#8B5CF6',
  brandTo:   LIGHT ? '#0891B2' : '#22D3EE',

  // The dark palette is intentionally vivid; the light palette uses darker
  // equivalents because Ink renders these colours directly on the terminal.
  accent:   LIGHT ? '#6D28D9' : '#A78BFA', // assistant / brand text
  user:     LIGHT ? '#0F766E' : '#5EEAD4', // the human's turn
  output:   LIGHT ? '#1F2937' : '#CBD5E1', // assistant response text
  thinking: LIGHT ? '#475569' : '#94A3B8', // reasoning traces
  tool:     LIGHT ? '#BE185D' : '#F472B6', // tool calls
  code:     LIGHT ? '#0369A1' : '#7DD3FC', // inline code and fenced blocks
  ok:       LIGHT ? '#047857' : '#34D399',
  warn:     LIGHT ? '#B45309' : '#FBBF24',
  error:    LIGHT ? '#B91C1C' : '#F87171',
  muted:    LIGHT ? '#4B5563' : '#6B7280', // labels, hints, chrome
  faint:    LIGHT ? '#6B7280' : '#4B5563', // rules, gutters
  text:     LIGHT ? '#1F2937' : '#E5E7EB',
} as const;

export const G = {
  prompt:    '❯',
  steer:     '↪',
  pending:   '◍',
  assistant: '◆',
  tool:      '●',
  gutter:    '│',
  bullet:    '·',
  ok:        '✓',
  no:        '✗',
  warn:      '▲',
  err:       '✖',
  rule:      '━',
} as const;

/** Braille dot spinner — reads as a smooth rotation at ~80ms/frame. */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

// ── colour maths ──────────────────────────────────────────────────────────────

function toRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);

/** Linear blend between two hex colours. `t` is clamped to 0..1. */
export function mix(a: string, b: string, t: number): string {
  const k = clamp01(t);
  const [ar, ag, ab] = toRgb(a);
  const [br, bg, bb] = toRgb(b);
  const ch = (x: number, y: number) =>
    Math.round(x + (y - x) * k).toString(16).padStart(2, '0');
  return `#${ch(ar, br)}${ch(ag, bg)}${ch(ab, bb)}`;
}

/** Brand gradient sample at position `t` (0 = violet, 1 = cyan). */
export const brand = (t: number): string => mix(C.brandFrom, C.brandTo, t);
