import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitEventContent, fitSafetyReason, fitToolContent, judgeLabel } from './MessageRow.js';

// A safety row is commentary on the tool call directly above it, and says so by
// sitting under the same gutter. Wrapping breaks that: ink puts the
// continuation at column 0, so the second line reads as a new top-level event.
// Everything here is about the row staying on one line.

const JUDGE = 'ling-3.0-flash';
const FULL_LABEL = 'openrouter/inclusionai/ling-3.0-flash';

/** What the row actually costs, mirroring the JSX in MessageRow. */
function rowWidth(reason: string, judge: string, caller?: string): number {
  const gutter = '  │ '.length;
  const callerTag = caller ? `${caller} `.length : 0;
  const label = '✓ safety '.length;
  const judgeTag = judge ? `  ·  ${judge}`.length : 0;
  return gutter + callerTag + label + reason.length + judgeTag;
}

test('judgeLabel keeps the model and drops the provider path', () => {
  assert.equal(judgeLabel(FULL_LABEL), JUDGE);
});

test('judgeLabel tolerates a bare model name and a missing one', () => {
  assert.equal(judgeLabel('gpt-4o-mini'), 'gpt-4o-mini');
  assert.equal(judgeLabel(undefined), '');
});

test('a short reason is left alone', () => {
  const reason = 'routine edit';
  assert.equal(fitSafetyReason(reason, { judge: JUDGE, caller: 'coder', columns: 120 }), reason);
});

test('a long reason is cut so the row still fits one line', () => {
  const long = 'The edit targets plan.md, a planning document, and adds a new bullet point describing an agentic coding loops feature. This is routine.';
  for (const columns of [60, 80, 100, 120, 200]) {
    const fitted = fitSafetyReason(long, { judge: JUDGE, caller: 'coder', columns });
    assert.ok(
      rowWidth(fitted, JUDGE, 'coder') <= columns,
      `at ${columns} columns the row came to ${rowWidth(fitted, JUDGE, 'coder')}`,
    );
  }
});

test('the cut is marked, so a clipped reason never reads as the whole one', () => {
  const long = 'x'.repeat(400);
  const fitted = fitSafetyReason(long, { judge: JUDGE, caller: 'coder', columns: 80 });
  assert.ok(fitted.endsWith('…'), `expected an ellipsis, got ${JSON.stringify(fitted.slice(-8))}`);
});

test('a row with no caller gives that space back to the reason', () => {
  const long = 'y'.repeat(400);
  const withCaller = fitSafetyReason(long, { judge: JUDGE, caller: 'coder', columns: 80 });
  const without = fitSafetyReason(long, { judge: JUDGE, columns: 80 });
  assert.equal(without.length - withCaller.length, 'coder '.length);
});

test('a terminal too narrow for anything yields no reason rather than a negative width', () => {
  const fitted = fitSafetyReason('some reason', { judge: JUDGE, caller: 'coder', columns: 10 });
  assert.equal(fitted, '');
});

// ── fitToolContent ────────────────────────────────────────────────────────────

test('a nested tool row leaves the label columns intact', () => {
  // The real one from a spawned agent, which broke the row.
  const command = 'cd packages/engine && find ../../node_modules/@agentionai/agents -name "*.d.ts" | head -50';
  const columns = 80;
  const fitted = fitToolContent(command, { parent: 'agent2', title: 'run_shell', columns });

  const rendered = '    ' + 'agent2' + ' ' + '● ' + 'run_shell' + '  ' + fitted;
  assert.ok(rendered.length <= columns,
    `the whole row must fit in ${columns} columns, got ${rendered.length}`);
  assert.ok(fitted.length > 0, 'an 80-column terminal has room for some of the command');
});

test('a short command is left alone', () => {
  const fitted = fitToolContent('npm test', { parent: 'agent1', title: 'run_shell', columns: 120 });
  assert.equal(fitted, 'npm test');
});

test('a row with no room drops the content rather than showing a bare ellipsis', () => {
  assert.equal(fitToolContent('anything', { parent: 'agent12', title: 'run_shell', columns: 20 }), '');
});

test('a top-level tool row (no parent) still fits a long command into the row', () => {
  // The real one from the bug report: "Run shell" ran into the command with
  // no visible separator on a narrow terminal.
  const command = 'tail -5 pagoda-garden.html; echo ---; grep -n "ACTORS\\|PRESETS\\|crags\\|cragTop" pagoda-garden.html';
  const columns = 60;
  const fitted = fitToolContent(command, { title: 'Run shell', columns });

  const rendered = '● ' + 'Run shell' + '  ' + fitted;
  assert.ok(rendered.length <= columns,
    `the whole row must fit in ${columns} columns, got ${rendered.length}`);
  assert.ok(fitted.length > 0, 'a 60-column terminal has room for some of the command');
});

test('a top-level row with a caller reserves room for it too', () => {
  const long = 'z'.repeat(400);
  const withCaller = fitToolContent(long, { caller: 'agent2', title: 'run_shell', columns: 80 });
  const without = fitToolContent(long, { title: 'run_shell', columns: 80 });
  assert.equal(without.length - withCaller.length, 'agent2 '.length);
});

// ── job / agent completion rows ────────────────────────────────────────────────
//
// The row that arrives with no turn running. When it wraps there is nothing
// above it to anchor the continuation, so "background" breaking into "backgrou"
// above a stray "d" is the whole event becoming unreadable rather than merely ugly.

/** What a completion row actually costs, mirroring EventRow's JSX. */
function eventRowWidth(label: string, title: string, content: string, note?: string): number {
  const icon = '✓ '.length;
  const tag = `${label} `.length;
  const gap = '  '.length;
  const noteCols = note ? `  ·  ${note}`.length : 0;
  return icon + tag + title.length + gap + content.length + noteCols;
}

const LONG_COMMAND =
  'pnpm exec prettier --write apps/server/src/campaigns/work-service.ts '
  + 'apps/cli/src/help.test.ts README.md && pnpm test && pnpm typecheck && pnpm lint '
  + '&& git diff --check';

test('a completion row leaves a short command alone', () => {
  const content = fitEventContent('npm test', {
    label: 'background ', title: 'job1', note: 'exit 0  ·  12.3s', columns: 120,
  });
  assert.equal(content, 'npm test');
});

test('a completion row cuts a long command so it still fits one line', () => {
  for (const columns of [60, 80, 100, 120, 200]) {
    const note = 'exit 0  ·  16.0s';
    const fitted = fitEventContent(LONG_COMMAND, {
      label: 'background ', title: '7', note, columns,
    });
    const width = eventRowWidth('background', '7', fitted, note);
    assert.ok(width <= columns, `at ${columns} columns the row came to ${width}`);
  }
});

test('the outcome survives a command long enough to bury it', () => {
  // The regression: the note is budgeted as fixed, so `exit 0 · 16.0s · picking
  // it up` is never what gets dropped. Before, a long command squeezed every
  // column beside it and the outcome was pushed onto a second line.
  const note = 'exit 0  ·  16.0s  ·  picking it up';
  const columns = 100;
  const fitted = fitEventContent(LONG_COMMAND, {
    label: 'background ', title: '7', note, columns,
  });
  assert.ok(fitted.length > 0, 'the command should still be shown, just cut');
  assert.ok(eventRowWidth('background', '7', fitted, note) <= columns);
});

test('a longer note leaves less room for the command, not the other way round', () => {
  const columns = 100;
  const short = fitEventContent(LONG_COMMAND, {
    label: 'background ', title: '7', note: 'exit 0', columns,
  });
  const long = fitEventContent(LONG_COMMAND, {
    label: 'background ', title: '7', note: 'exit 0  ·  16.0s  ·  picking it up', columns,
  });
  assert.ok(long.length < short.length);
});

test('an agent row budgets its shorter label', () => {
  const columns = 100;
  const asJob = fitEventContent(LONG_COMMAND, { label: 'background ', title: 'a1', columns });
  const asAgent = fitEventContent(LONG_COMMAND, { label: 'agent ', title: 'a1', columns });
  assert.equal(asAgent.length - asJob.length, 'background '.length - 'agent '.length);
});

test('a hopeless width drops the command rather than leaving a bare ellipsis', () => {
  assert.equal(
    fitEventContent(LONG_COMMAND, {
      label: 'background ', title: 'job1', note: 'exit 0  ·  16.0s', columns: 20,
    }),
    '',
  );
});

test('a missing note costs nothing', () => {
  const columns = 80;
  assert.ok(
    fitEventContent(LONG_COMMAND, { label: 'background ', title: '7', columns }).length
    > fitEventContent(LONG_COMMAND, { label: 'background ', title: '7', note: 'exit 0', columns }).length,
  );
});
