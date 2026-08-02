import { useRef } from 'react';

/**
 * Stands a large paste behind a one-line placeholder until it is submitted.
 *
 * The prompt is in Ink's live region, redrawn in place on every keystroke, so a
 * fifty-line paste rendered literally is a fifty-row frame. Past the terminal
 * height that frame scrolls, and a scrolled frame makes Ink's line-count erase
 * wrong — the same repaint storm LiveOutput's row budget exists to prevent.
 *
 * A placeholder sidesteps it rather than budgeting around it: the frame stays
 * one row tall however much was pasted, and `expand` puts the real text back on
 * the way to the engine. The user's text is never altered, only hidden.
 */
export interface PasteBuffer {
  /** Returns what to insert: the text itself, or a placeholder standing for it. */
  capture(text: string): string;
  /** Restore every placeholder in `value` to the text it stands for. */
  expand(value: string): string;
  /** Forget everything captured so far. Call once the value has been consumed. */
  clear(): void;
}

/** Below this a paste is short enough to just show — collapsing it would hide
 *  something the user can perfectly well read, and read back before sending. */
const COLLAPSE_LINES = 4;
const COLLAPSE_CHARS = 400;

export function shouldCollapse(text: string): boolean {
  return text.split('\n').length > COLLAPSE_LINES || text.length > COLLAPSE_CHARS;
}

/**
 * The label carries a count so the placeholder says what it is hiding, and an id
 * so two pastes in one prompt never expand to each other's text.
 */
export function placeholderFor(id: number, text: string): string {
  const lines = text.split('\n').length;
  const size = lines > 1 ? `${lines} lines` : `${text.length} chars`;
  return `[paste #${id}: ${size}]`;
}

/** The buffer itself — plain state, no React, so it can be driven directly. */
export function createPasteBuffer(): PasteBuffer {
  const store = new Map<string, string>();
  let nextId = 1;

  return {
    capture(text: string): string {
      if (!shouldCollapse(text)) return text;
      const placeholder = placeholderFor(nextId++, text);
      store.set(placeholder, text);
      return placeholder;
    },

    expand(value: string): string {
      let expanded = value;
      for (const [placeholder, text] of store) {
        // split/join rather than replace: the placeholder contains regex
        // metacharacters, and a literal pass is also what makes a partly-deleted
        // placeholder simply not match instead of half-expanding.
        expanded = expanded.split(placeholder).join(text);
      }
      return expanded;
    },

    clear(): void {
      store.clear();
      nextId = 1;
    },
  };
}

export function usePasteBuffer(): PasteBuffer {
  // A ref rather than state: none of this affects the render, and re-rendering
  // on capture would fight the value update the paste is already causing.
  // Initialised by hand because `useRef(createPasteBuffer())` would build a new
  // buffer on every render and throw all but the first away.
  const buffer = useRef<PasteBuffer | null>(null);
  buffer.current ??= createPasteBuffer();
  return buffer.current;
}
