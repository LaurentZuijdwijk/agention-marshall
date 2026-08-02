import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { runSlashCommand } from './commands.js';
import type { CommandDeps, CommandSession } from './commands.js';
import type { Transcript } from './hooks/useTranscript.js';
import type { Mode } from './mode.js';
import type { Message } from './view/message.js';
import type { AgentProfile } from '@marshall/engine';

// ── fakes ─────────────────────────────────────────────────────────────────────

interface Pushed { role: string; content: string }

function fakeTranscript() {
  const pushed: Pushed[] = [];
  let reset: Message[] | null = null;
  let key = 0;
  const transcript = {
    messages: [], stream: '', reasoning: '', epoch: 0,
    push: (role: string, content: string) => { pushed.push({ role, content }); },
    reset: (messages: Message[]) => { reset = messages; },
    nextKey: () => String(++key),
    appendStream: () => {}, clearStream: () => {}, takeStream: () => '',
    appendReasoning: () => {}, takeReasoning: () => '',
    replay: () => {},
  } as unknown as Transcript;
  return { transcript, pushed, get reset() { return reset; } };
}

const PROFILE: AgentProfile = { provider: 'claude', model: 'claude-sonnet-4-6' };

function setup(overrides: Partial<CommandDeps> = {}) {
  const t = fakeTranscript();
  const modes: Mode[] = [];
  const calls = {
    plan: [] as string[],
    review: [] as (string | undefined)[],
    cleared: 0,
    denyAll: 0,
    quit: 0,
    applied: [] as Array<[AgentProfile, AgentProfile | undefined]>,
    steering: [] as boolean[],
  };

  const session: CommandSession = {
    plan: async (task) => { calls.plan.push(task); },
    review: async (notes) => { calls.review.push(notes); },
    clear: async () => { calls.cleared++; return 'history cleared'; },
  };

  const prefs = {
    showUsage: false, stream: true, showReasoning: false,
    toggle: (key: 'showUsage' | 'stream' | 'showReasoning') => {
      const next = !prefs[key];
      (prefs as Record<string, unknown>)[key] = next;
      return next;
    },
    read: () => ({ showUsage: prefs.showUsage, stream: prefs.stream, showReasoning: prefs.showReasoning }),
  };

  const deps: CommandDeps = {
    workspaceRoot: '/tmp/workspace',
    transcript: t.transcript,
    session,
    approvals: {
      pending: 0,
      enqueue: () => ({ promise: Promise.resolve('approve' as const), show: null }),
      resolve: () => null,
      denyAll: () => { calls.denyAll++; return 0; },
    },
    prefs: prefs as unknown as CommandDeps['prefs'],
    setMode: (mode) => { modes.push(mode); },
    setSteering: (value) => { calls.steering.push(value); },
    headerMessage: () => ({ key: 'h', role: 'header', content: '' }),
    applyProfiles: (deep, fast) => { calls.applied.push([deep, fast]); },
    activeProfile: PROFILE,
    quit: () => { calls.quit++; },
    startLogin: () => ({ authUrl: 'https://auth.example' } as never),
    ...overrides,
  };

  return { deps, modes, calls, pushed: t.pushed, transcript: t };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('runSlashCommand', () => {
  it('reports an unrecognised command without touching the session', () => {
    const { deps, pushed, modes } = setup();
    runSlashCommand('/nope', deps);
    assert.equal(pushed[0].role, 'error');
    assert.match(pushed[0].content, /unknown command: \/nope/);
    assert.deepEqual(modes, []);
  });

  it('reports misuse with the command’s own usage line', () => {
    const { deps, pushed } = setup();
    runSlashCommand('/plan', deps);
    assert.equal(pushed[0].role, 'error');
    assert.match(pushed[0].content, /usage: \/plan/);
  });

  it('echoes /plan, runs it, and goes busy', async () => {
    const { deps, calls, pushed, modes } = setup();
    runSlashCommand('/plan add a login form', deps);
    assert.deepEqual(calls.plan, ['add a login form']);
    assert.deepEqual(pushed, [{ role: 'user', content: '/plan add a login form' }]);
    assert.deepEqual(modes, [{ type: 'running' }]);
  });

  it('passes undefined for a bare /review', () => {
    const { deps, calls } = setup();
    runSlashCommand('/review', deps);
    assert.deepEqual(calls.review, [undefined]);
  });

  it('returns to idle and surfaces the error when a task rejects', async () => {
    const { deps, pushed, modes } = setup({
      session: {
        plan: async () => { throw new Error('provider unreachable'); },
        review: async () => {},
        clear: async () => 'cleared',
      },
    });
    runSlashCommand('/plan something', deps);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(modes, [{ type: 'running' }, { type: 'idle' }]);
    assert.deepEqual(pushed.at(-1), { role: 'error', content: 'provider unreachable' });
  });

  it('refuses to start work before a model is chosen', () => {
    const { deps, pushed, modes } = setup({ session: null });
    runSlashCommand('/plan something', deps);
    assert.equal(pushed[0].role, 'error');
    assert.deepEqual(modes, [], 'must not strand the UI in running mode');
  });

  it('opens the wizard on the tier /model names', () => {
    const { deps, modes } = setup();
    runSlashCommand('/model', deps);
    runSlashCommand('/model deep', deps);
    runSlashCommand('/model fast', deps);
    assert.deepEqual(modes, [
      { type: 'setup', tier: 'deep', chain: true },
      { type: 'setup', tier: 'deep', chain: false },
      { type: 'setup', tier: 'fast', chain: false },
    ]);
  });

  it('drops the fast tier on /model off without opening the wizard', () => {
    const { deps, modes, calls } = setup();
    runSlashCommand('/model off', deps);
    assert.deepEqual(calls.applied, [[PROFILE, undefined]]);
    assert.deepEqual(modes, []);
  });

  it('toggles preferences and says which way they went', () => {
    const { deps, pushed } = setup();
    runSlashCommand('/tokens', deps);
    assert.match(pushed[0].content, /shown/);
    runSlashCommand('/tokens', deps);
    assert.match(pushed[1].content, /hidden/);

    runSlashCommand('/stream', deps);
    assert.match(pushed[2].content, /only when complete/);
  });

  it('prints the workspace for /cwd and the help text for /help', () => {
    const { deps, pushed } = setup();
    runSlashCommand('/cwd', deps);
    assert.deepEqual(pushed[0], { role: 'info', content: '/tmp/workspace' });
    runSlashCommand('/help', deps);
    assert.match(pushed[1].content, /\/model/);
  });

  it('quits on /exit', () => {
    const { deps, calls } = setup();
    runSlashCommand('/exit', deps);
    assert.equal(calls.quit, 1);
  });

  it('explains a missing AGENTS.md rather than erroring', () => {
    const { deps, pushed } = setup();
    runSlashCommand('/memory', deps);
    assert.equal(pushed[0].role, 'info');
    assert.match(pushed[0].content, /No AGENTS\.md/);
  });

  it('starts a login and waits for the pasted code', () => {
    const { deps, pushed, modes } = setup();
    runSlashCommand('/login', deps);
    assert.match(pushed[0].content, /https:\/\/auth\.example/);
    assert.equal(modes[0].type, 'login-pending');
  });

  it('denies pending approvals and rebuilds the transcript on /clear', async () => {
    const { deps, calls, transcript } = setup();
    const write = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      runSlashCommand('/clear', deps);
      await new Promise(resolve => setImmediate(resolve));
    } finally {
      process.stdout.write = write;
    }

    assert.equal(calls.denyAll, 1);
    assert.equal(calls.cleared, 1);
    assert.deepEqual(calls.steering, [false]);
    assert.equal(transcript.reset?.[0].role, 'header');
    assert.equal(transcript.reset?.[1].content, 'history cleared');
  });
});
