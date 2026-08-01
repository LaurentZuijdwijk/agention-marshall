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
import { Text, useInput } from 'ink';
import chalk from 'chalk';

export interface TextInputProps {
  value: string;
  placeholder?: string;
  focus?: boolean;
  showCursor?: boolean;
  /** Echo this instead of the real characters (secrets). */
  mask?: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
}

export function TextInput({
  value: originalValue,
  placeholder = '',
  focus = true,
  showCursor = true,
  mask,
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
      renderedValue += i === cursorOffset ? chalk.inverse(char) : char;
      i++;
    }
    if (display.length > 0 && cursorOffset === display.length) {
      renderedValue += chalk.inverse(' ');
    }
  }

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
      nextValue = value.slice(0, cursorOffset) + input + value.slice(cursorOffset);
      nextCursorOffset += input.length;
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
