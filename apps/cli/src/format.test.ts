import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatToolInput, formatToolName, shortenPath, truncate, clampToRows, windowRange, formatUsageReport } from './format.js';
import type { UsageReport } from '@agentionai/marshall-engine';
import { mix, brand } from './view/theme.js';

describe('formatToolName', () => {
  it('title-cases a snake_case tool identifier', () => {
    assert.equal(formatToolName('edit_file'), 'Edit file');
    assert.equal(formatToolName('run_shell'), 'Run shell');
  });

  it('leaves a single-word name capitalised', () => {
    assert.equal(formatToolName('context'), 'Context');
  });
});

describe('formatToolInput', () => {
  it('returns an empty string for empty or non-object input', () => {
    assert.equal(formatToolInput({}), '');
    assert.equal(formatToolInput(undefined), '');
    assert.equal(formatToolInput(null), '');
    assert.equal(formatToolInput('nope'), '');
  });

  it('shows the primary key verbatim', () => {
    assert.equal(formatToolInput({ path: 'src/App.tsx' }), 'src/App.tsx');
    assert.equal(formatToolInput({ command: 'npm test' }), 'npm test');
  });

  it('notes how many other keys were folded away', () => {
    assert.equal(formatToolInput({ path: 'a.ts', start: 1, end: 20 }), 'a.ts  +2');
  });

  it('collapses whitespace so a multi-line command stays on one row', () => {
    assert.equal(formatToolInput({ command: 'git diff\n  --stat' }), 'git diff --stat');
  });

  it('falls back to key=value pairs, summarising nested values', () => {
    assert.equal(
      formatToolInput({ recursive: true, items: [1, 2, 3], opts: { a: 1 } }),
      'recursive=true items=[3] opts={…}',
    );
  });

  it('truncates past the max width', () => {
    assert.equal(formatToolInput({ command: 'x'.repeat(200) }, 10), 'x'.repeat(9) + '…');
  });
});

describe('truncate', () => {
  it('leaves short text alone', () => {
    assert.equal(truncate('abc', 10), 'abc');
  });

  it('never exceeds the max width', () => {
    assert.equal(truncate('abcdefghij', 5).length, 5);
  });
});

describe('shortenPath', () => {
  it('collapses the home directory', () => {
    assert.equal(shortenPath('/home/me/code/app', '/home/me'), '~/code/app');
  });

  it('leaves paths outside home untouched', () => {
    assert.equal(shortenPath('/srv/app', '/home/me'), '/srv/app');
  });

  it('elides leading segments when too long, keeping the tail', () => {
    const out = shortenPath('/a/very/deeply/nested/project/path/here', undefined, 20);
    assert.ok(out.startsWith('…/'), out);
    assert.ok(out.endsWith('here'), out);
    assert.ok(out.length <= 22, out);
  });
});

describe('formatToolInput — sub-agent briefs', () => {
  it('shows the brief itself, not an instructions= prefix', () => {
    // `context` takes { instructions }, which was falling through to the
    // key=value fallback and rendering as "instructions=Explore this…".
    const out = formatToolInput({ instructions: 'Explore the CLI package' });
    assert.equal(out, 'Explore the CLI package');
  });

  it('still folds away the other keys', () => {
    const out = formatToolInput({ instructions: 'survey apps/cli', depth: 2 });
    assert.equal(out, 'survey apps/cli  +1');
  });
});

describe('clampToRows', () => {
  it('returns short text untouched', () => {
    assert.equal(clampToRows('one\ntwo', 80, 10), 'one\ntwo');
  });

  it('keeps the last rows once the text is taller than the budget', () => {
    assert.equal(clampToRows('a\nb\nc\nd', 80, 2), 'c\nd');
  });

  it('counts wrapped rows, not newlines', () => {
    // 20 chars at width 10 is two rows, so this is 3 rows in total.
    assert.equal(clampToRows('x'.repeat(20) + '\ntail', 10, 2), 'x'.repeat(10) + '\ntail');
  });

  it('preserves blank lines as rows', () => {
    assert.equal(clampToRows('a\n\nb', 80, 2), '\nb');
  });

  it('never exceeds the row budget', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i} ${'y'.repeat(30)}`).join('\n');
    const out = clampToRows(text, 20, 6);
    const rows = out.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 20)), 0);
    assert.ok(rows <= 6, `expected <= 6 rows, got ${rows}`);
  });

  it('degrades safely on a zero-sized terminal', () => {
    assert.equal(clampToRows('anything', 0, 10), '');
    assert.equal(clampToRows('anything', 80, 0), '');
  });
});

describe('theme colours', () => {
  it('mixes hex endpoints', () => {
    assert.equal(mix('#000000', '#ffffff', 0), '#000000');
    assert.equal(mix('#000000', '#ffffff', 1), '#ffffff');
    assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
  });

  it('clamps out-of-range positions', () => {
    assert.equal(mix('#000000', '#ffffff', -3), '#000000');
    assert.equal(mix('#000000', '#ffffff', 9), '#ffffff');
  });

  it('always produces a well-formed hex colour along the brand ramp', () => {
    for (let i = 0; i <= 10; i++) {
      assert.match(brand(i / 10), /^#[0-9a-f]{6}$/);
    }
  });
});

describe('windowRange', () => {
  it('shows everything when the list fits', () => {
    assert.deepEqual(windowRange(5, 0, 9), { start: 0, end: 5 });
  });

  it('keeps the cursor centred once scrolling', () => {
    assert.deepEqual(windowRange(17, 8, 9), { start: 4, end: 13 });
  });

  it('never scrolls past either end', () => {
    assert.deepEqual(windowRange(17, 0, 9), { start: 0, end: 9 });
    assert.deepEqual(windowRange(17, 16, 9), { start: 8, end: 17 });
  });
});

describe('formatUsageReport', () => {
  const report = (over: Partial<UsageReport> = {}): UsageReport => ({
    turn: { inputTokens: 10, outputTokens: 20 },
    session: { inputTokens: 101_000, outputTokens: 9_050, costUsd: 0.0421 },
    byRole: [
      { role: 'coder', model: 'openrouter/openai/gpt-5.6-luna', inputTokens: 100_000, outputTokens: 9_000, costUsd: 0.0421 },
      { role: 'context', model: 'llamacpp/qwen3-8b', inputTokens: 1_000, outputTokens: 50, costUsd: 0 },
    ],
    ...over,
  });

  it('leads with the session total and breaks it down per agent', () => {
    const lines = formatUsageReport(report()).split('\n');
    assert.match(lines[0], /^session {2}↑101,000 {2}↓9,050 {2}\$0\.0421$/);
    assert.match(lines[1], /coder/);
    assert.match(lines[1], /openrouter\/openai\/gpt-5\.6-luna/);
    assert.match(lines[2], /context/);
  });

  it('aligns the columns off the longest entry, not a fixed width', () => {
    const lines = formatUsageReport(report()).split('\n').slice(1);
    const arrows = lines.map(line => line.indexOf('↑'));
    assert.equal(arrows[0], arrows[1], 'the token columns line up');
  });

  it('breaks the thinking out of the output count', () => {
    const text = formatUsageReport(report({
      session: { inputTokens: 100_000, outputTokens: 9_000, reasoningTokens: 6_100, costUsd: 0.04 },
    }));
    assert.match(text, /↓9,000 \(6,100 thinking\)/,
      'billed as output either way, so it sits inside that figure rather than beside it');
  });

  it('says nothing about thinking for a model that does none', () => {
    assert.doesNotMatch(formatUsageReport(report()), /thinking/);
  });

  it('says nothing about cost for a role that has no price', () => {
    const text = formatUsageReport(report({
      session: { inputTokens: 100, outputTokens: 50 },
      byRole: [{ role: 'coder', model: 'claude/claude-opus-5', inputTokens: 100, outputTokens: 50 }],
    }));
    assert.doesNotMatch(text, /\$/);
    assert.match(text, /↑100/);
  });

  it('explains the + rather than leaving it to be guessed', () => {
    const text = formatUsageReport(report({
      session: { inputTokens: 100, outputTokens: 50, costUsd: 0.01, costPartial: true },
    }));
    assert.match(text, /\$0\.0100\+/);
    assert.match(text, /no published price/);
  });

  it('says so plainly when nothing has run yet', () => {
    assert.equal(formatUsageReport(report({ byRole: [] })), 'no tokens spent yet');
  });
});
