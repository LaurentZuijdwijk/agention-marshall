import { test } from 'node:test';
import assert from 'node:assert/strict';
import { History } from '@agentionai/agents/core';
import type { ReducibleEntry } from '@agentionai/agents/core';
import { compactSummaryPrompt, CompressionManager, middleCompressionPlugin } from './session-compression.js';
import type { EngineConfig } from './config.js';

const CONFIG: EngineConfig = {
  agent: { provider: 'ollama', model: 'test-model', host: 'http://127.0.0.1:11434' },
  workspaceRoot: '/tmp',
};

function manager(config: EngineConfig = CONFIG) {
  const history = new History();
  const logs: string[] = [];
  return { history, logs, compression: new CompressionManager(history, () => config, line => logs.push(line)) };
}

test('compactSummaryPrompt truncates oversized tool results', () => {
  const prompt = `[user]: find the file\n[tool]: ${'x'.repeat(2_000)}\n[assistant]: done`;
  const compacted = compactSummaryPrompt(prompt);

  assert.ok(compacted.includes('[tool output omitted during compression]'));
  assert.ok(compacted.includes('[assistant]: done'));
  assert.ok(compacted.length < prompt.length);
  assert.ok(compacted.length <= 24_000);
});

test('compactSummaryPrompt leaves short tool results and ordinary lines intact', () => {
  const prompt = '[user]: hello\n[tool]: short result\n[assistant]: ' + 'y'.repeat(1_300);

  assert.equal(compactSummaryPrompt(prompt), prompt);
});

test('compactSummaryPrompt caps an oversized prompt after compacting tool output', () => {
  const compacted = compactSummaryPrompt('z'.repeat(30_000));

  assert.equal(compacted.length, 24_000 + '\n[older compression input omitted]'.length);
  assert.ok(compacted.endsWith('[older compression input omitted]'));
});

test('compressionThreshold zero disables compression', async () => {
  const config = { ...CONFIG, compressionThreshold: 0 };
  const { history, logs, compression } = manager(config);
  history.addText('user', 'conversation');

  await compression.ensure();
  await compression.compressIfNeeded();
  assert.equal(await compression.compressForContextError('request (5000 tokens) exceeds the available context size (4000 tokens)'), false);
  assert.equal(history.length, 1);
  assert.ok(logs.some(line => line.includes('no summariser available')));
});

test('context compression reports no progress for an empty history', async () => {
  const { logs, compression } = manager({ ...CONFIG, compressionThreshold: 1 });

  // A zero-token history has nothing that a summary can remove, even when the
  // context error itself says the request is too large.
  assert.equal(await compression.compressForContextError('request (5000 tokens) exceeds the available context size (4000 tokens)'), false);
  assert.ok(logs.some(line => line.includes('history is empty')));
});

// ---------------------------------------------------------------------------
// middleCompressionPlugin.reduce — the real windowing / tail-selection logic
//
// These drive the production plugin's `reduce` directly (with the summariser
// `execute` stubbed, so nothing touches the network), verifying the exact
// window arithmetic: the contiguous middle window it folds, which entries it
// must never compress, how it computes coversRange, and the early-outs.
// ---------------------------------------------------------------------------

type MetaExtra = Partial<ReducibleEntry['__metadata']>;

// A plain entry the plugin's reduce can consume without going through History.
function text(role: string, text: string, tokens: number, extra: MetaExtra = {}): ReducibleEntry {
  return {
    role: role as ReducibleEntry['role'],
    content: [{ type: 'text', text }],
    __metadata: {
      date: '2024-01-01T00:00:00.000Z',
      contentLength: text.length,
      estimatedTokens: tokens,
      ...extra,
    },
  };
}

// The real plugin with a stubbed summariser: no agent, no network.
function plugin() {
  return middleCompressionPlugin(async () => '[summary]');
}

test('middleCompressionPlugin compresses only the middle, preserving system, first and newest tail', async () => {
  const system = text('system', 'sys', 10);
  const first = text('user', 'first', 100, { date: '2024-01-01T00:00:00.000Z' });
  const e2 = text('user', 'e2', 100, { date: '2024-01-02T00:00:00.000Z' });
  const e3 = text('user', 'e3', 100, { date: '2024-01-03T00:00:00.000Z' });
  const e4 = text('user', 'e4', 100, { date: '2024-01-04T00:00:00.000Z' });
  const e5 = text('user', 'e5', 100, { date: '2024-01-05T00:00:00.000Z' });
  const e6 = text('user', 'e6', 100, { date: '2024-01-06T00:00:00.000Z' });
  const entries = [system, first, e2, e3, e4, e5, e6];

  const result = await plugin().reduce!(entries, { maxTokens: 399 });

  // 6 non-system entries, each 100 tokens, plus a 10-token system entry. The
  // tail walk (system+first=110, then newest back) fits E6 (210), E5 (310), but
  // E4 would push to 410 > 399, so tail = [E5, E6] and middle = [E2, E3, E4].
  assert.equal(result.length, 5);
  assert.equal(result[0], system, 'system entry is never compressed and stays first');
  assert.equal(result[1], first, 'the first conversational entry is never compressed');
  assert.equal(result[3], e5, 'newest tail entries are preserved in order');
  assert.equal(result[4], e6, 'the very newest entry is always preserved');

  // The middle window [E2, E3, E4] must have been folded into one summary, with
  // no gap or overlap against the preserved first + tail.
  const summary = result.find(e => e.__metadata.isSummary);
  assert.ok(summary, 'middle is folded into a summary entry');
  assert.equal(summary!.role, 'user');
  assert.equal(summary!.__metadata.isSummary, true);
  // coversRange derived from entry dates when there is no prior summary.
  assert.deepEqual(summary!.__metadata.coversRange, { from: '2024-01-02T00:00:00.000Z', to: '2024-01-04T00:00:00.000Z' });
});

test('middleCompressionPlugin always keeps the newest entry even when it alone exceeds budget', async () => {
  const first = text('user', 'first', 100);
  const middleOnly = text('user', 'middle', 500);
  const newest = text('user', 'newest', 500);
  const entries = [first, middleOnly, newest];

  const result = await plugin().reduce!(entries, { maxTokens: 300 });

  // 1100 total > 300, 3 non-system entries. Walk: newest (500) forces keep via
  // the tail.length === 0 clause; the next entry would exceed and break, so
  // middle = [middleOnly] gets compressed, newest survives.
  assert.equal(result.length, 3);
  assert.equal(result[0], first);
  assert.equal(result[2], newest, 'newest is preserved by the force-keep clause even though it overflows alone');
  assert.ok(result[1].__metadata.isSummary, 'middle entry is the one compressed');
});

test('middleCompressionPlugin extends a prior summary coversRange from its from to the last covered entry', async () => {
  const first = text('user', 'first', 100);
  const e2 = text('user', 'e2', 100, { date: '2024-01-02T00:00:00.000Z' });
  const prior = text('user', 'prior', 100, {
    date: '2024-01-03T00:00:00.000Z',
    isSummary: true,
    coversRange: { from: '2024-01-01T00:00:00.000Z', to: '2024-01-03T00:00:00.000Z' },
  });
  const e4 = text('user', 'e4', 100, { date: '2024-01-06T00:00:00.000Z' });
  const e5 = text('user', 'e5', 100, { date: '2024-01-07T00:00:00.000Z' });
  const e6 = text('user', 'e6', 100, { date: '2024-01-08T00:00:00.000Z' });
  const entries = [first, e2, prior, e4, e5, e6];

  const result = await plugin().reduce!(entries, { maxTokens: 399 });

  // tail = [E5, E6] (like the first case), middle = [E2, prior, E4]. The new
  // summary's coversRange borrows the prior summary's `from` and runs to the
  // last covered entry (E4) date.
  const summary = result.find(e => e.__metadata.isSummary && e !== prior);
  assert.ok(summary, 'a new summary embedding the prior summary is produced');
  assert.deepEqual(summary!.__metadata.coversRange, {
    from: '2024-01-01T00:00:00.000Z',
    to: '2024-01-06T00:00:00.000Z',
  });
});

test('middleCompressionPlugin leaves entries untouched when maxTokens already fits', async () => {
  const entries = [
    text('user', 'a', 50),
    text('user', 'b', 50),
    text('user', 'c', 50),
    text('user', 'd', 50),
  ];

  const result = await plugin().reduce!(entries, { maxTokens: 10_000 });
  assert.equal(result, entries, 'fits-under-budget early-out returns the same array');
});

test('middleCompressionPlugin leaves entries untouched with fewer than 3 non-system entries', async () => {
  const entries = [
    text('system', 'sys', 10),
    text('user', 'a', 5_000),
    text('user', 'b', 5_000),
  ];

  // total (10_010) far exceeds maxTokens, but only 2 non-system entries.
  const result = await plugin().reduce!(entries, { maxTokens: 10 });
  assert.equal(result, entries, 'fewer-than-3 non-system entries early-out returns the same array');
});

test('middleCompressionPlugin leaves entries untouched when maxTokens is undefined', async () => {
  const entries = [text('user', 'a', 100), text('user', 'b', 100), text('user', 'c', 100)];
  const result = await plugin().reduce!(entries, {});
  assert.equal(result, entries);
});

test('middleCompressionPlugin handles a lone prior summary in the middle without crashing or undefined range', async () => {
  const first = text('user', 'first', 100);
  const prior = text('user', 'prior', 100, {
    date: '2024-01-02T00:00:00.000Z',
    isSummary: true,
    coversRange: { from: '2024-01-01T00:00:00.000Z', to: '2024-01-02T00:00:00.000Z' },
  });
  const newest = text('user', 'newest', 100, { date: '2024-01-03T00:00:00.000Z' });
  const entries = [first, prior, newest];

  const result = await plugin().reduce!(entries, { maxTokens: 250 });

  // middle = [prior] only (newest kept as the tail). covered is empty, so both
  // boundaries must fall back to the prior summary's own range — never undefined.
  const summary = result.find(e => e.__metadata.isSummary && e !== prior);
  assert.ok(summary, 'a lone-prior-summary middle still produces a fresh summary');
  const coversRange = summary.__metadata.coversRange;
  assert.ok(coversRange, 'the summary carries a coversRange');
  assert.equal(coversRange.from, '2024-01-01T00:00:00.000Z');
  assert.equal(coversRange.to, '2024-01-02T00:00:00.000Z');
});

test('compactSummaryPrompt leaves a tool line exactly at the limit intact', () => {
  // '[tool]: ' is 8 chars, so 1192 payload chars make the line exactly 1200.
  const line = `[tool]: ${'x'.repeat(1_192)}`;
  assert.equal(line.length, 1_200);
  assert.equal(compactSummaryPrompt(line), line);
});

test('compactSummaryPrompt truncates an oversized single tool line to the limit plus the omission marker', () => {
  const line = `[tool]: ${'y'.repeat(1_292)}`; // 1300 chars, over the 1200 limit
  const compacted = compactSummaryPrompt(line);
  const marker = ' …[tool output omitted during compression]';
  assert.equal(compacted, `${line.slice(0, 1_200)}${marker}`);
});

test('compressForContextError drives the real reduce plugin end-to-end with a stubbed summariser', async () => {
  const { history, logs, compression } = manager(CONFIG);

  // Inject a fake summariser so ensure() (which would otherwise create a real
  // agent) is skipped, then register the real compression plugin with a stub.
  (compression as unknown as { summaryAgent: { execute: () => Promise<string> } }).summaryAgent = {
    execute: async () => '[summary]',
  };
  history.use(middleCompressionPlugin(async () => '[summary]'));

  for (let i = 0; i < 30; i++) history.addText('user', 'x'.repeat(4_000));
  const current = history.totalEstimatedTokens;
  assert.ok(current > 20_000, 'precondition: large enough history to compress');

  const reduced = await compression.compressForContextError(
    'llama.cpp API error: 400 request (14231 tokens) exceeds the available context size (13312 tokens)');

  assert.equal(reduced, true, 'a working stub summariser should let compression report progress');
  assert.ok(history.totalEstimatedTokens < current, 'history should shrink below its starting size');
  assert.ok(logs.some(line => line.includes('CONTEXT_ERROR_COMPRESSED')));
});
