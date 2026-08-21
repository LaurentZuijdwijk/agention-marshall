// ── what the terminal ends up showing ─────────────────────────────────────────
//
// The rest of the suite asserts on the bytes Ink wrote. That cannot see the bug
// users actually report — the same answer printed six times — because the bytes
// are right and the erase in front of them is wrong. These tests replay the
// stream through a screen model (../testing/screen.ts) and assert on the result.

import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import React from 'react';
import { startFakeProvider } from '@agentionai/marshall-engine/testing';
import type { ScriptedTurn } from '@agentionai/marshall-engine/testing';
import { App } from '../App.js';
import { fakeStdout, fakeStdin, renderTui, waitFor, KEY } from '../testing/ink.js';
import { Screen } from '../testing/screen.js';

/** A paragraph long enough to wrap, which is the case that goes wrong. */
const ANSWER =
  'Wrote a short story called **The Last Lighthouse Keeper** to `story.md` — about a solitary '
  + 'lighthouse keeper on Skerry Isle who risks everything in a storm to rescue two men from a '
  + 'sinking fishing boat, and finds that solitude was never what she was truly looking for.';

/**
 * Several paragraphs of ordinary prose.
 *
 * Length is the point, and so is the variety of line breaks. Whether a wrapped
 * line lands on the terminal's last column depends on where the words happen to
 * fall, so one short paragraph can pass an edge check by luck — this one is long
 * enough that some line lands badly at any width.
 */
const STORY = [
  'There was a tire swing hanging from the lowest limb, faded black, frayed at the edges. '
  + 'Manuel stepped closer and touched the rubber with his fingers. It was still soft.',
  '',
  "He remembered every detail of the last summer he'd spent here. He was twelve. The world was "
  + 'enormous and made of small things: the taste of raw watermelon in August, the sound of his '
  + "mother's sandals slapping the kitchen tiles, the smell of copal smoke drifting from his "
  + "grandmother's room at night. Rosa used to tell him stories under that mesquite tree after "
  + 'dinner. Stories about a star who fell in love with the ocean, about a dog who could speak the '
  + 'language of ghosts, about a city that existed only in dreams and was made entirely of light.',
  '',
  'He sat down on the tire swing. It held.',
  '',
  '"Don\'t you go getting sentimental on me," he muttered to no one. But his voice was quiet, and '
  + 'the evening was patient.',
].join('\n');

/** A phrase from the first wrapped row — the row a short erase leaves behind. */
const FIRST_ROW = 'Wrote a short story called';

async function drive(t: TestContext, script: ScriptedTurn[], size = { columns: 100, rows: 30 }) {
  const workspace = mkdtempSync(join(tmpdir(), 'marshall-cli-repaint-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const fake = await startFakeProvider(...script);
  t.after(() => fake.close());

  const screen = new Screen(size);
  let raw = '';
  const stdout = fakeStdout(chunk => { raw += chunk; screen.write(chunk); }, size.columns, size.rows);
  const stdin = fakeStdin();

  const instance = renderTui(
    React.createElement(App, {
      workspaceRoot: workspace,
      agentProfile: { provider: 'llamacpp', host: fake.host, model: 'test-model' },
    }),
    { stdout, stdin },
  );
  t.after(() => instance.unmount());

  return {
    screen,
    until: (text: string, what = `"${text}"`) => waitFor(() => raw.includes(text), what),
    async submit(task: string) {
      await waitFor(() => raw.includes('type a task'), 'the idle prompt');
      stdin.push(task);
      await waitFor(() => raw.includes(task), 'the typed task to echo');
      stdin.push(KEY.enter);
    },
  };
}

test('a streamed answer is left on screen exactly once', async (t) => {
  const app = await drive(t, [{ text: ANSWER }]);

  await app.submit('write a story');
  await app.until('truly looking for', 'the answer');
  // The live preview is replaced by the committed row on the next frame.
  await waitFor(() => app.screen.count('type a task') > 0, 'the prompt to come back');

  assert.equal(
    app.screen.count(FIRST_ROW), 1,
    `the answer is on screen ${app.screen.count(FIRST_ROW)} times:\n${app.screen.text()}`,
  );
});

test('a multi-step turn leaves one copy of each step', async (t) => {
  const app = await drive(t, [
    { text: ANSWER, toolCalls: [{ name: 'read_file', arguments: { path: 'nope.md' } }] },
    { text: 'Done.' },
  ]);

  await app.submit('write a story');
  await app.until('Done.', 'the final answer');

  assert.equal(
    app.screen.count(FIRST_ROW), 1,
    `the first step is on screen ${app.screen.count(FIRST_ROW)} times:\n${app.screen.text()}`,
  );
});

test('a narrow terminal still leaves one copy', async (t) => {
  const app = await drive(t, [{ text: ANSWER }], { columns: 60, rows: 24 });

  await app.submit('write a story');
  await app.until('truly looking for', 'the answer');
  await waitFor(() => app.screen.count('type a task') > 0, 'the prompt to come back');

  assert.equal(
    app.screen.count(FIRST_ROW), 1,
    `the answer is on screen ${app.screen.count(FIRST_ROW)} times:\n${app.screen.text()}`,
  );
});

// The cause, rather than the symptom. Ink rewinds as many rows as the frame has
// lines; the terminal counts rows it actually drew. A line that reaches the last
// column breaks that equivalence — wrapped, it costs a row the rewind never gets
// back, and a stale row is left behind per frame. Asserting on width catches the
// regression at the point it is introduced, rather than as mysterious duplicate
// output several turns later.
test('nothing ever reaches the terminal edge', async (t) => {
  for (const size of [{ columns: 60, rows: 24 }, { columns: 80, rows: 30 }, { columns: 100, rows: 30 }, { columns: 120, rows: 40 }, { columns: 137, rows: 46 }]) {
    // A committed row and a live one, since they are laid out by separate passes
    // — <Static> gets its own, and does not inherit the root's width.
    const app = await drive(t, [{ text: STORY, toolCalls: [{ name: 'read_file', arguments: { path: 'nope.md' } }] }, { text: 'Done.' }], size);

    await app.submit('write a story');
    await app.until('Done.', 'the final answer');

    const tooWide = app.screen.lines()
      .map((line, i) => ({ line, i, width: line.length }))
      .filter(row => row.width >= size.columns);

    assert.deepEqual(
      tooWide.map(r => `row ${r.i} is ${r.width} wide`), [],
      `at ${size.columns} columns every line must stay under the edge:\n${app.screen.text()}`,
    );
  }
});

// ── reasoning that arrives pre-broken ─────────────────────────────────────────
//
// Reasoning is the one text on screen whose line structure the provider decides.
// An OpenRouter stealth endpoint terminated every delta with a newline, and the
// reasoning block rendered as a column of single words down the left edge —
// `for` / `a` / `demo` / `).`, one per row, forty rows for two sentences.
//
// Worth asserting end to end rather than on `reflowProse` alone: the two
// reasoning rows (live preview and committed row) are separate components, and
// the failure is only visible once one of them has actually been drawn.
const PER_DELTA_REASONING = 'The build succeeded and the chunk-size warning is expected and harmless for a demo. '
  .split(' ').map(word => ` ${word}`).join('\n');

test('reasoning broken at every delta still renders as prose', async (t) => {
  for (const size of [{ columns: 60, rows: 24 }, { columns: 100, rows: 30 }, { columns: 137, rows: 46 }]) {
    const app = await drive(t, [{ reasoning: PER_DELTA_REASONING, text: 'Done.' }], size);

    await app.submit('check the build');
    await app.until('Done.', 'the final answer');

    // The words are all there, on far fewer rows than there are words.
    const rows = app.screen.lines().filter(line => line.includes('chunk-size warning'));
    assert.ok(rows.length > 0, `the reasoning never reached the screen:\n${app.screen.text()}`);
    assert.ok(
      rows.every(row => row.trim().split(/\s+/).length > 1),
      `reasoning rendered one word per row at ${size.columns} columns:\n${app.screen.text()}`,
    );
  }
});
