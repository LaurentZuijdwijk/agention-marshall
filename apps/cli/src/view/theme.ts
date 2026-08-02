// ── theme ─────────────────────────────────────────────────────────────────────
//
// One place for colour and glyphs so the banner, prompt, message rows and setup
// wizard all speak the same visual language. Colours are truecolor hex — chalk
// (via ink) downsamples them automatically on 256/16-colour terminals.

export const C = {
  /** Brand gradient endpoints — violet → cyan. */
  brandFrom: '#8B5CF6',
  brandTo:   '#22D3EE',

  accent: '#A78BFA', // assistant / brand text
  user:   '#5EEAD4', // the human's turn
  tool:   '#F472B6', // tool calls
  code:   '#7DD3FC', // inline code and fenced blocks
  ok:     '#34D399',
  warn:   '#FBBF24',
  error:  '#F87171',
  muted:  '#6B7280', // labels, hints, chrome
  faint:  '#4B5563', // rules, gutters
  text:   '#E5E7EB',
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
