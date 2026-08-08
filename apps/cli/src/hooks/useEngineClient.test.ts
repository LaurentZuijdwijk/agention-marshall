import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEngineClient } from './useEngineClient.js';
import type { TranscriptPort, TurnOutcome } from './useEngineClient.js';
import type { OutputEvent } from '@agentionai/marshall-engine';
import type { ApprovalRequest } from '@agentionai/marshall-tools';

interface Pushed { role: string; content: string; extra?: Record<string, unknown> }

function harness(opts: { usage?: boolean; reasoning?: string; stream?: string } = {}) {
  const pushed: Pushed[] = [];
  const calls: string[] = [];
  const usage: Array<{ inputTokens: number; outputTokens: number; durationMs: number }> = [];
  let pendingReasoning = opts.reasoning ?? '';
  // Stands in for the live buffer the real port keeps: tokens land in it and a
  // take empties it, which is what the ordering rules below are written against.
  let pendingStream = opts.stream ?? '';

  const port: TranscriptPort = {
    push: (role, content, extra) => {
      pushed.push({ role, content, extra: extra as Record<string, unknown> | undefined });
      calls.push(`push:${role}`);
    },
    appendToken: (t) => { pendingStream += t; calls.push(`token:${t}`); },
    appendReasoning: (t) => { pendingReasoning += t; calls.push(`reasoning:${t}`); },
    takeStream: () => { const s = pendingStream; pendingStream = ''; calls.push('takeStream'); return s; },
    takeReasoning: () => { const r = pendingReasoning; pendingReasoning = ''; calls.push('takeReasoning'); return r; },
    turnStarted: () => calls.push('turnStarted'),
    turnEnded: (o: TurnOutcome) => calls.push(`turnEnded:${o}`),
    reportUsage: (inputTokens, outputTokens, durationMs) => usage.push({ inputTokens, outputTokens, durationMs }),
    requestApproval: async () => 'approve',
    showUsage: () => opts.usage ?? false,
  };

  const client = createEngineClient(port);
  return { client, pushed, calls, usage, send: (e: OutputEvent) => client.onOutput(e) };
}

describe('tool calls', () => {
  it('renders an ordinary tool as a tool row', () => {
    const h = harness();
    h.send({ type: 'tool-call', toolName: 'read_file', input: { path: 'a.ts' } });
    assert.equal(h.pushed[0].role, 'tool');
    assert.equal(h.pushed[0].content, 'a.ts');
    assert.equal(h.pushed[0].extra?.note, undefined);
  });

  it('renders an agent-backed tool as an agent row carrying its model', () => {
    const h = harness();
    h.send({
      type: 'tool-call', toolName: 'context', input: { instructions: 'survey apps/cli' },
      subagent: { model: 'llamacpp/qwen', delegated: true },
    });
    assert.equal(h.pushed[0].role, 'agent');
    assert.equal(h.pushed[0].content, 'survey apps/cli');
    assert.equal(h.pushed[0].extra?.note, 'llamacpp/qwen');
    assert.equal(h.pushed[0].extra?.delegated, true);
  });

  it('marks an agent that is not delegated, so it still reads as an agent', () => {
    const h = harness();
    h.send({
      type: 'tool-call', toolName: 'planner', input: { instructions: 'plan' },
      subagent: { model: 'openrouter/deepseek', delegated: false },
    });
    assert.equal(h.pushed[0].role, 'agent');
    assert.equal(h.pushed[0].extra?.delegated, false);
  });

  it('tags a nested call with the agent that owns it', () => {
    const h = harness();
    h.send({ type: 'tool-call', toolName: 'read_file', input: { path: 'x.ts' }, parent: 'context#1' });
    assert.equal(h.pushed[0].extra?.parent, 'context#1');
  });

  it('names the agent behind a top-level call that is not the coder', () => {
    const h = harness();
    h.send({ type: 'tool-call', toolName: 'read_file', input: { path: 'x.ts' }, caller: 'review' });
    assert.equal(h.pushed[0].extra?.caller, 'review');
  });

  it('leaves the coder unnamed — it is the default voice, not an aside', () => {
    const h = harness();
    h.send({ type: 'tool-call', toolName: 'read_file', input: { path: 'x.ts' } });
    assert.ok(!('caller' in (h.pushed[0].extra ?? {})));
  });
});

describe('tool results', () => {
  it('shows a top-level result', () => {
    const h = harness();
    h.send({ type: 'tool-result', toolName: 'read_file', result: 'contents' });
    assert.deepEqual(h.calls, ['push:tool-result']);
  });

  it('drops a sub-agent result, which would otherwise drown the transcript', () => {
    const h = harness();
    h.send({ type: 'tool-result', toolName: 'read_file', result: 'contents', parent: 'context#0' });
    assert.deepEqual(h.calls, []);
  });
});

describe('safety verdicts', () => {
  it('renders an approve verdict as a safety row with the tool name as title', () => {
    const h = harness();
    h.send({ type: 'safety-verdict', toolName: 'run_shell', outcome: 'approve', reason: 'routine test run', model: 'openrouter/nvidia/...' });
    assert.equal(h.pushed[0].role, 'safety');
    assert.equal(h.pushed[0].content, 'routine test run');
    assert.equal(h.pushed[0].extra?.title, 'Run shell'); // formatToolName humanises it, same as a tool-call row
    assert.equal(h.pushed[0].extra?.note, 'openrouter/nvidia/...');
    assert.equal(h.pushed[0].extra?.safetyOutcome, 'approve');
  });

  it('renders a deny verdict — the tool call is still awaiting the human at this point', () => {
    const h = harness();
    h.send({ type: 'safety-verdict', toolName: 'run_shell', outcome: 'deny', reason: 'deletes outside the workspace', model: 'openai/gpt-4o-mini' });
    assert.equal(h.pushed[0].extra?.safetyOutcome, 'deny');
  });

  it('renders an unclear verdict (judge unreachable or ambiguous)', () => {
    const h = harness();
    h.send({ type: 'safety-verdict', toolName: 'read_file', outcome: 'unclear', reason: 'judge unreachable — ECONNREFUSED', model: 'llamacpp/local' });
    assert.equal(h.pushed[0].extra?.safetyOutcome, 'unclear');
  });

  it('carries the caller through, same as a tool-call row', () => {
    const h = harness();
    h.send({ type: 'safety-verdict', toolName: 'read_file', outcome: 'approve', reason: 'ok', model: 'x/y', caller: 'review' });
    assert.equal(h.pushed[0].extra?.caller, 'review');
  });

  it('omits caller for the coder, same as a tool-call row', () => {
    const h = harness();
    h.send({ type: 'safety-verdict', toolName: 'read_file', outcome: 'approve', reason: 'ok', model: 'x/y' });
    assert.ok(!('caller' in (h.pushed[0].extra ?? {})));
  });
});

describe('sub-agent completion', () => {
  it('reports size and duration on success', () => {
    const h = harness();
    h.send({ type: 'subagent-done', label: 'context#0', durationMs: 28300, chars: 4100 });
    assert.equal(h.pushed[0].content, '4.1k chars');
    assert.equal(h.pushed[0].extra?.note, '28.3s');
    assert.equal(h.pushed[0].extra?.failed, false);
  });

  it('reports the error and marks the row failed', () => {
    const h = harness();
    h.send({ type: 'subagent-done', label: 'context#0', durationMs: 900, chars: 0, error: 'cannot reach host' });
    assert.equal(h.pushed[0].content, 'cannot reach host');
    assert.equal(h.pushed[0].extra?.failed, true);
  });
});

describe('turn completion', () => {
  it('commits reasoning before the answer, then ends the turn', () => {
    const h = harness({ reasoning: 'thinking out loud' });
    h.send({ type: 'response', text: 'the answer' });
    assert.deepEqual(h.pushed.map(p => p.role), ['reasoning', 'assistant']);
    assert.equal(h.pushed[0].content, 'thinking out loud');
    assert.equal(h.pushed[1].content, 'the answer');
    assert.equal(h.calls.at(-1), 'turnEnded:done');
  });

  it('omits the reasoning row when there is none', () => {
    const h = harness();
    h.send({ type: 'response', text: 'the answer' });
    assert.deepEqual(h.pushed.map(p => p.role), ['assistant']);
  });

  it('commits the answer once, not once per source', () => {
    // The final text arrives twice — token by token, then whole on the event.
    const h = harness();
    h.send({ type: 'token', text: 'the ' });
    h.send({ type: 'token', text: 'answer' });
    h.send({ type: 'response', text: 'the answer' });
    assert.deepEqual(h.pushed.map(p => p.content), ['the answer']);
  });

  it('falls back to the streamed text when the final event carries none', () => {
    const h = harness();
    h.send({ type: 'token', text: 'all I said' });
    h.send({ type: 'response', text: '' });
    assert.deepEqual(h.pushed.map(p => p.content), ['all I said']);
  });

  it('an interrupt keeps the partial answer that was on screen', () => {
    const h = harness({ reasoning: 'partial thought' });
    h.send({ type: 'token', text: 'half a sent' });
    h.send({ type: 'interrupted' });
    assert.deepEqual(h.pushed.map(p => p.role), ['reasoning', 'assistant', 'info']);
    assert.equal(h.pushed[1].content, 'half a sent');
    assert.equal(h.calls.at(-1), 'turnEnded:interrupted');
  });

  it('a full context window ends the turn like an interrupt, not an error', () => {
    const h = harness();
    h.send({ type: 'context-full', compressed: true });
    assert.equal(h.pushed.at(-1)?.role, 'info');
    assert.match(h.pushed.at(-1)?.content ?? '', /compressed the conversation/);
    assert.equal(h.calls.at(-1), 'turnEnded:interrupted');
  });

  it('a full context window that could not be compressed says so', () => {
    const h = harness();
    h.send({ type: 'context-full', compressed: false });
    assert.match(h.pushed.at(-1)?.content ?? '', /could not be compressed automatically/);
  });

  it('an error ends the turn without steering', () => {
    const h = harness();
    h.send({ type: 'error', message: 'boom' });
    assert.deepEqual(h.pushed.map(p => p.role), ['error']);
    assert.equal(h.calls.at(-1), 'turnEnded:error');
  });
});

describe('step ordering', () => {
  it('commits what the model said before the tool it then called', () => {
    const h = harness();
    h.send({ type: 'reasoning', text: 'need the config' });
    h.send({ type: 'token', text: 'Reading the config first.' });
    h.send({ type: 'tool-call', toolName: 'read_file', input: { path: 'a.ts' } });
    h.send({ type: 'tool-result', toolName: 'read_file', result: 'contents' });
    h.send({ type: 'response', text: 'Done.' });

    assert.deepEqual(h.pushed.map(p => p.role), [
      'reasoning', 'assistant', 'tool', 'tool-result', 'assistant',
    ]);
    assert.equal(h.pushed[1].content, 'Reading the config first.');
    assert.equal(h.pushed[4].content, 'Done.');
  });

  it('keeps each step in its own block instead of pooling them at the end', () => {
    const h = harness();
    h.send({ type: 'token', text: 'first step' });
    h.send({ type: 'tool-call', toolName: 'read_file', input: { path: 'a.ts' } });
    h.send({ type: 'token', text: 'second step' });
    h.send({ type: 'tool-call', toolName: 'edit_file', input: { path: 'a.ts' } });
    h.send({ type: 'response', text: 'finished' });

    assert.deepEqual(h.pushed.map(p => p.content), [
      'first step', 'a.ts', 'second step', 'a.ts', 'finished',
    ]);
  });

  it('takes mid-turn prose from the event when the provider does not stream', () => {
    const h = harness();
    h.send({ type: 'assistant', text: 'Reading the config first.' });
    h.send({ type: 'tool-call', toolName: 'read_file', input: { path: 'a.ts' } });
    assert.deepEqual(h.pushed.map(p => p.role), ['assistant', 'tool']);
    assert.equal(h.pushed[0].content, 'Reading the config first.');
  });

  it('never shows mid-turn prose twice when a provider both streams and reports it', () => {
    const h = harness();
    h.send({ type: 'token', text: 'Reading the config first.' });
    h.send({ type: 'assistant', text: 'Reading the config first.' });
    h.send({ type: 'tool-call', toolName: 'read_file', input: { path: 'a.ts' } });
    assert.deepEqual(h.pushed.map(p => p.role), ['assistant', 'tool']);
  });

  it('drops an empty mid-turn message rather than committing a blank row', () => {
    const h = harness();
    h.send({ type: 'assistant', text: '   ' });
    assert.deepEqual(h.pushed, []);
  });
});

describe('usage', () => {
  it('is hidden by default', () => {
    const h = harness({ usage: false });
    h.send({ type: 'usage', inputTokens: 10, outputTokens: 20, durationMs: 1500 });
    assert.deepEqual(h.calls, []);
  });

  it('reports usage to the status port when enabled', () => {
    const h = harness({ usage: true });
    h.send({ type: 'usage', inputTokens: 10, outputTokens: 20, durationMs: 1500 });
    assert.deepEqual(h.pushed, []);
    assert.deepEqual(h.usage, [{ inputTokens: 10, outputTokens: 20, durationMs: 1500 }]);
  });
});

describe('plan and review', () => {
  it('renders a plan as markdown and ends the turn', () => {
    const h = harness();
    h.send({ type: 'plan', text: '1. do the thing' });
    assert.equal(h.pushed[0].role, 'markdown');
    assert.equal(h.pushed[0].extra?.title, 'plan');
    assert.deepEqual(h.calls, ['push:markdown', 'turnEnded:done']);
  });

  it('renders a review as markdown', () => {
    const h = harness();
    h.send({ type: 'review', text: 'LGTM' });
    assert.equal(h.pushed[0].extra?.title, 'review');
  });

  it('renders a goal as markdown and ends the turn, same as a plan', () => {
    const h = harness();
    h.send({ type: 'goal', text: 'done means users can log in with Google' });
    assert.equal(h.pushed[0].role, 'markdown');
    assert.equal(h.pushed[0].extra?.title, 'goal');
    assert.deepEqual(h.calls, ['push:markdown', 'turnEnded:done']);
  });
});

describe('streaming', () => {
  it('forwards tokens and reasoning to the port, which owns the gating', () => {
    const h = harness();
    h.send({ type: 'token', text: 'hel' });
    h.send({ type: 'reasoning', text: 'hmm' });
    assert.deepEqual(h.calls, ['token:hel', 'reasoning:hmm']);
  });

  it('turns thinking into a turn-started signal and nothing else', () => {
    const h = harness();
    h.send({ type: 'thinking' });
    assert.deepEqual(h.calls, ['turnStarted']);
    assert.deepEqual(h.pushed, []);
  });
});

describe('background jobs', () => {
  const done = (over: Partial<Extract<OutputEvent, { type: 'job-done' }>> = {}): OutputEvent => ({
    type: 'job-done',
    id: 'job1',
    command: 'npm test',
    status: 'exited',
    exitCode: 0,
    durationMs: 12_300,
    resuming: false,
    ...over,
  });

  it('renders a completion as a job row carrying the command', () => {
    const h = harness();
    h.send(done());
    assert.equal(h.pushed[0].role, 'job');
    assert.equal(h.pushed[0].content, 'npm test');
    assert.equal(h.pushed[0].extra?.title, 'job1');
    assert.equal(h.pushed[0].extra?.failed, false);
    assert.match(String(h.pushed[0].extra?.note), /exit 0/);
    assert.match(String(h.pushed[0].extra?.note), /12\.3s/);
  });

  it('marks a non-zero exit as failed', () => {
    const h = harness();
    h.send(done({ exitCode: 1 }));
    assert.equal(h.pushed[0].extra?.failed, true);
  });

  it('marks a timeout as failed and says so', () => {
    const h = harness();
    h.send(done({ status: 'timed-out', exitCode: null }));
    assert.equal(h.pushed[0].extra?.failed, true);
    assert.match(String(h.pushed[0].extra?.note), /timed out/);
  });

  it('says when the engine is about to act on the result', () => {
    const h = harness();
    h.send(done({ resuming: true }));
    assert.match(String(h.pushed[0].extra?.note), /picking it up/);
  });

  it('commits the model mid-sentence prose above the completion', () => {
    const h = harness({ stream: 'partial answer' });
    h.send(done());
    assert.deepEqual(h.pushed.map(p => p.role), ['assistant', 'job']);
    assert.equal(h.pushed[0].content, 'partial answer');
  });

  it('does not end the turn — a completion can land mid-turn', () => {
    const h = harness();
    h.send(done());
    assert.ok(!h.calls.some(c => c.startsWith('turnEnded')));
  });
});

describe('approvals', () => {
  it('delegates to the port', async () => {
    const h = harness();
    const req = { toolName: 'write_file', description: 'w', detail: 'd' } as ApprovalRequest;
    assert.equal(await h.client.requestApproval(req), 'approve');
  });
});

describe('mcp state', () => {
  const state = (servers: unknown[]): OutputEvent =>
    ({ type: 'mcp-state', servers } as OutputEvent);

  it('says nothing when every server is healthy', () => {
    const h = harness();
    h.send(state([{ name: 'linear', url: 'u', status: 'connected', toolNames: ['a'] }]));
    assert.deepEqual(h.pushed, []);
  });

  it('reports a server that could not be reached', () => {
    const h = harness();
    h.send(state([{ name: 'linear', url: 'u', status: 'error', toolNames: [], error: 'ECONNREFUSED' }]));
    assert.equal(h.pushed[0].role, 'error');
    assert.match(h.pushed[0].content, /linear/);
    assert.match(h.pushed[0].content, /ECONNREFUSED/);
  });

  it('reports each failure separately', () => {
    const h = harness();
    h.send(state([
      { name: 'a', url: 'u', status: 'error', toolNames: [], error: 'x' },
      { name: 'b', url: 'u', status: 'connected', toolNames: [] },
      { name: 'c', url: 'u', status: 'error', toolNames: [], error: 'y' },
    ]));
    assert.deepEqual(h.pushed.map(p => p.role), ['error', 'error']);
  });

  it('does not end the turn — this can arrive mid-turn or with no turn at all', () => {
    const h = harness();
    h.send(state([{ name: 'a', url: 'u', status: 'error', toolNames: [], error: 'x' }]));
    assert.ok(!h.calls.some(c => c.startsWith('turnEnded')));
  });
});
