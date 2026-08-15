// ── the wrapped-paragraph regression ──────────────────────────────────────────
//
// Ink's default text wrap (wrap-ansi's `trim: false` mode) has a bug: when a
// word boundary lands exactly on the column width, the row it pushes next
// picks up a stray leading space instead of starting flush. Most continuation
// lines of a wrapped paragraph land clean; the odd one, wherever a word happens
// to end exactly at the wrap column, comes out indented by one column — a
// ragged left edge on prose that is otherwise a clean block.
//
// Patched in patches/ink+*.patch (see AGENTS.md); this is the regression test
// for that patch, run through actual rendering rather than against wrap-ansi
// directly, so an ink upgrade that drops the patch — or changes its own
// defaults — fails a test instead of only failing `npm install`.

import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { MarkdownView } from './MarkdownView.js';
import { fakeStdout, fakeStdin, renderTui, waitFor } from '../testing/ink.js';
import { Screen } from '../testing/screen.js';

/** Long and varied enough that some wrapped line lands on a column boundary
 *  at any width — a short paragraph can pass this check by luck. */
const STORY =
  'The night deepens, and the tribe gathers around the flickering flames, their eyes reflecting '
  + 'the dance of shadows upon the cavern walls. Old Brute recounts the legend of the Great River '
  + 'that once surged beyond the mountains, its waters now a memory, yet its spirit lives on in the '
  + "song of the waterfalls that echo through the stone. He speaks of the brave hunters who followed "
  + 'the mammoth across icy plains, their spears glinting in the dawn light, and of the sacred stones '
  + "they placed at the herd's path to ensure safe passage.";

async function render(t: TestContext, columns: number) {
  const screen = new Screen({ columns, rows: 40 });
  const stdout = fakeStdout(chunk => screen.write(chunk), columns, 40);
  const instance = renderTui(React.createElement(MarkdownView, { text: STORY }), { stdout, stdin: fakeStdin() });
  t.after(() => instance.unmount());
  await waitFor(() => screen.text().includes('night deepens'), 'the paragraph to render');
  return screen;
}

test('a wrapped paragraph has no line beginning with a stray leading space', async (t) => {
  // The bug is specific to where a word happens to fall relative to the
  // column width, not to any one width — sweep a range the way the earlier
  // manual repro did.
  for (const columns of [40, 50, 60, 65, 68, 72, 80, 100]) {
    const screen = await render(t, columns);
    const lines = screen.lines().filter(line => line.trim() !== '');
    for (const line of lines) {
      assert.equal(line.startsWith(' '), false,
        `at ${columns} columns, line ${JSON.stringify(line)} starts with a stray space`);
    }
  }
});
