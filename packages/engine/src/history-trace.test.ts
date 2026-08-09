import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { serialiseHistory, traceMode } from './history-trace.js';
import type { HistoryEntry } from '@agentionai/agents/core';

const conversation: HistoryEntry[] = [
  { role: 'user', content: [{ type: 'text', text: 'write me a short story' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'Here is a story about a lighthouse keeper.' }] },
  {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'call_0', name: 'write_file', input: { path: 'story.md' } }],
  },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_0', content: 'wrote story.md' }] },
];

describe('traceMode', () => {
  it('is off unless asked for', () => {
    for (const value of [undefined, '', '0', 'false']) {
      assert.equal(traceMode(value), 'off', `${JSON.stringify(value)} should not enable tracing`);
    }
  });

  it('treats any other value as on, and "full" as untruncated', () => {
    assert.equal(traceMode('1'), 'truncated');
    assert.equal(traceMode('true'), 'truncated');
    assert.equal(traceMode('full'), 'full');
  });
});

describe('serialiseHistory', () => {
  it('shows every entry with its role and kind, in order', () => {
    const lines = serialiseHistory(conversation).split('\n');
    assert.equal(lines.length, 4);
    assert.match(lines[0], /user text\s+write me a short story/);
    assert.match(lines[1], /assistant text\s+Here is a story about a lighthouse keeper\./);
    assert.match(lines[2], /assistant tool_use write_file/);
    assert.match(lines[3], /user tool_result/);
  });

  it('keeps the answer the follow-up turn depends on', () => {
    // The whole reason this exists: proving an earlier answer is in the document
    // the model receives, so "it forgot" can be pinned on the model or on us.
    assert.match(serialiseHistory(conversation), /Here is a story about a lighthouse keeper\./);
  });

  it('truncates long content but says how much it cut', () => {
    const long: HistoryEntry[] = [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(5_000) }] }];
    const out = serialiseHistory(long, { maxChars: 100 });
    assert.match(out, /\+4900 more chars/);
    assert.ok(out.length < 500, 'the clipped line should be short');
  });

  it('does not truncate at all when asked not to', () => {
    const long: HistoryEntry[] = [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(5_000) }] }];
    assert.ok(serialiseHistory(long, { maxChars: 0 }).includes('x'.repeat(5_000)));
  });

  it('marks a tool result that was rewritten on the way out', () => {
    // What the masking plugin does: the stored result is intact, the one being
    // sent is a placeholder. Reading only one of the two hides that entirely.
    const sent: HistoryEntry[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_0', content: '[masked, 4kb]' }] },
    ];
    const raw: HistoryEntry[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_0', content: 'the whole file' }] },
    ];
    assert.match(serialiseHistory(sent, { raw }), /\[masked\]/);
  });

  it('leaves an untouched tool result unmarked', () => {
    assert.doesNotMatch(serialiseHistory(conversation, { raw: conversation }), /\[masked\]/);
  });

  it('indents wrapped content under its own entry', () => {
    const multi: HistoryEntry[] = [{ role: 'assistant', content: [{ type: 'text', text: 'line one\nline two' }] }];
    const [, second] = serialiseHistory(multi).split('\n');
    assert.match(second, /^\s{20,}line two$/, 'a continuation should not start at column 0');
  });

  it('renders an empty history as an empty string rather than throwing', () => {
    assert.equal(serialiseHistory([]), '');
  });
});
