// ── text input ────────────────────────────────────────────────────────────────
//
// Vendored from ink-text-input@6 (MIT, vadimdemedes/ink-text-input), trimmed to
// what the CLI uses: controlled value, placeholder, submit. The package pins
// peer ink>=5/react>=18 and would drag a second copy of Ink 5 + React 18 into
// the tree next to Ink 7 + React 19 — two reconcilers on one stdin. Keeping the
// component in-tree avoids that split-brain setup.
//
// The cursor offset is derived state, not a plain useState: when the parent
// rewrites the value (autocomplete, clearing after submit), the offset must
// follow immediately — a useEffect correction runs a render too late, and the
// next keystroke inserts at the stale offset ("/mo" + "del" → "model/"…).

import React, { useState } from 'react';
import { Text, useInput, usePaste } from 'ink';
import chalk from 'chalk';

/**
 * Terminals send a line break inside pasted text as CR, not LF.
 *
 * A raw CR that reaches the rendered value is not inert: the terminal acts on
 * it and returns to column 0, so every pasted line was drawn on top of the one
 * before it — the paste looked shredded even though the value was intact.
 * Normalising on the way in keeps CR out of the value entirely, which is the
 * only place it can be fixed once and stay fixed.
 */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/**
 * What actually gets inserted when text is pasted.
 *
 * Trailing newlines are dropped: they come from copying whole lines, not from
 * anything the user meant to type. Keeping them would be actively wrong in the
 * single-value fields — an API key pasted with its line ending used to submit
 * the wizard, and once pastes stopped submitting it would have carried a
 * newline into the saved config instead.
 */
export function normalizePaste(text: string): string {
  return normalizeNewlines(text).replace(/\n+$/, '');
}

export interface TextInputProps {
  value: string;
  placeholder?: string;
  focus?: boolean;
  showCursor?: boolean;
  /** Echo this instead of the real characters (secrets). */
  mask?: string;
  /** Rewrite pasted text before it is inserted — used to stand a large paste
   *  behind a short placeholder. Defaults to inserting it verbatim. */
  onPaste?: (text: string) => string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
}

export function TextInput({
  value: originalValue,
  placeholder = '',
  focus = true,
  showCursor = true,
  mask,
  onPaste,
  onChange,
  onSubmit,
}: TextInputProps) {
  const value = originalValue || '';
  const display = mask ? mask.repeat(value.length) : value;

  const [state, setState] = useState({
    cursorOffset: value.length,
    /** The value the offset belongs to — anything else means it's stale. */
    value,
  });

  // Adjust state during render (React's supported pattern): when the value
  // changes without a matching keystroke from this component, snap the cursor
  // to the end. Typing round-trips through onChange with the handler's own
  // offset already recorded, so `state.value === value` and nothing moves.
  if (state.value !== value) {
    setState({ cursorOffset: value.length, value });
  }
  const cursorOffset = Math.min(state.cursorOffset, value.length);

  let renderedValue = display;
  let renderedPlaceholder = placeholder ? chalk.grey(placeholder) : undefined;

  // Fake cursor: inverse-video the character under it (or a trailing space).
  if (showCursor && focus) {
    renderedPlaceholder =
      placeholder.length > 0
        ? chalk.inverse(placeholder[0]) + chalk.grey(placeholder.slice(1))
        : chalk.inverse(' ');
    renderedValue = display.length > 0 ? '' : chalk.inverse(' ');
    let i = 0;
    for (const char of display) {
      // Highlighting a line break paints the inverse block to the edge of the
      // row on most terminals, so the cursor sitting on one is drawn as a space
      // in front of the break instead — visible, and no full-width bar.
      renderedValue += i === cursorOffset
        ? (char === '\n' ? chalk.inverse(' ') + '\n' : chalk.inverse(char))
        : char;
      i++;
    }
    if (display.length > 0 && cursorOffset === display.length) {
      renderedValue += chalk.inverse(' ');
    }
  }

  const insertAtCursor = (text: string) => {
    if (text === '') return;
    const nextValue = value.slice(0, cursorOffset) + text + value.slice(cursorOffset);
    setState({ cursorOffset: cursorOffset + text.length, value: nextValue });
    onChange(nextValue);
  };

  // Mounting this enables the terminal's bracketed-paste mode, which is what
  // makes a paste arrive whole and on its own channel. Without it the text came
  // through `useInput` as ordinary keystrokes, so a CR in the middle of it was
  // indistinguishable from the user pressing enter — a pasted block could submit
  // itself halfway through.
  usePaste((text) => {
    const pasted = normalizePaste(text);
    insertAtCursor(onPaste ? onPaste(pasted) : pasted);
  }, { isActive: focus });

  useInput((input, key) => {
    if (
      key.upArrow ||
      key.downArrow ||
      (key.ctrl && input === 'c') ||
      key.tab ||
      (key.shift && key.tab)
    ) {
      return;
    }

    if (key.return) {
      onSubmit?.(value);
      // The parent clears the value on submit; keep the offset valid for the
      // render that happens before the parent's state update lands.
      setState({ cursorOffset: 0, value: '' });
      return;
    }

    let nextCursorOffset = cursorOffset;
    let nextValue = value;

    if (key.leftArrow) {
      if (showCursor) nextCursorOffset--;
    } else if (key.rightArrow) {
      if (showCursor) nextCursorOffset++;
    } else if (key.backspace || key.delete) {
      if (cursorOffset > 0) {
        nextValue = value.slice(0, cursorOffset - 1) + value.slice(cursorOffset);
        nextCursorOffset--;
      }
    } else {
      // Fallback for terminals that ignore bracketed paste: the text lands here
      // as one oversized keystroke. Newlines identify it as a paste, so it gets
      // the same treatment rather than reaching the value raw.
      const isPaste = /[\r\n]/.test(input);
      const text = isPaste ? normalizePaste(input) : normalizeNewlines(input);
      const inserted = isPaste && onPaste ? onPaste(text) : text;
      nextValue = value.slice(0, cursorOffset) + inserted + value.slice(cursorOffset);
      nextCursorOffset += inserted.length;
    }

    if (nextCursorOffset < 0) nextCursorOffset = 0;
    if (nextCursorOffset > nextValue.length) nextCursorOffset = nextValue.length;

    setState({ cursorOffset: nextCursorOffset, value: nextValue });
    if (nextValue !== value) onChange(nextValue);
  }, { isActive: focus });

  return (
    <Text>
      {placeholder
        ? display.length > 0
          ? renderedValue
          : renderedPlaceholder
        : renderedValue}
    </Text>
  );
}
