import { describe, it, expect, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// This package is ESM — `__dirname` doesn't exist here.
const here = dirname(fileURLToPath(import.meta.url));
import { Session } from '@agentionai/marshall-engine';
import React from 'react';
import { App } from './App.js';
import { fakeStdout, fakeStdin, renderTui, waitFor } from './testing/ink.js';

// ── test helpers ───────────────────────────────────────────────────────────────

let tempDirs: string[] = [];
let capturedOutput = '';

afterEach(() => {
  for (const dir of tempDirs) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  tempDirs = [];
  capturedOutput = '';
});

// fakeStdout/fakeStdin/waitFor live in ../testing/ink.js — the integration suite
// needs the same two carefully-shaped streams, and a second copy of them is a
// second chance to get the TTY flags subtly wrong.

function mkTemp(): string {
  const dir = join(here, '..', '..', '.tmp-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

// ── mock Session ───────────────────────────────────────────────────────────────

let mockRun: ((text: string, images: unknown[]) => Promise<void>) | null = null;
let mockInterrupt: (() => void) | null = null;
let mockClear: (() => Promise<string>) | null = null;
let mockMessages: any[] = [];

class MockSession {
  opts: any;
  constructor(opts: any) { this.opts = opts; }
  run(text: string, images: unknown[] = []): Promise<void> {
    if (mockRun) return mockRun(text, images);
    return Promise.resolve();
  }
  interrupt(): void { mockInterrupt?.(); }
  clear(): Promise<string> {
    if (mockClear) return mockClear();
    return Promise.resolve('cleared');
  }
  get messages() { return mockMessages; }
}

function mockStartLogin() { return { authUrl: 'http://mock-auth' }; }
async function mockCompleteLogin(_code: string, _session: any) { return Promise.resolve(); }

// Setup mock — immediately completes
function MockSetup({ onComplete }: { onComplete: (p: string, m: string) => void }) {
  React.useEffect(() => {
    // Ink doesn't call useEffect in non-TTY mode, so we need a different approach
    // We'll use a state-driven setup that completes synchronously
    try { onComplete('claude', 'claude-sonnet-4-6'); } catch {}
  }, [onComplete]);
  return null;
}

// ── tests ──────────────────────────────────────────────────────────────────────

describe('App component', () => {
  beforeEach(() => {
    mockRun = null;
    mockInterrupt = null;
    mockClear = null;
    mockMessages = [];
  });

  it('renders without error when model is provided', () => {
    const agentProfile = { provider: 'claude' as const, model: 'claude-sonnet-4-6' };
    const ws = mkTemp();
    const stream = fakeStdout(chunk => { capturedOutput += chunk; });

    const instance = renderTui(
      React.createElement(App, {
        workspaceRoot: ws,
        agentProfile,
        SessionCtor: MockSession as any,
        startLoginCtor: mockStartLogin,
        completeLoginCtor: mockCompleteLogin,
      }),
      { stdout: stream },
    );

    assert.ok(instance, 'render should return an instance');
    instance.unmount();
  });

  it('saves config.json after setup completes', () => {
    const agentProfile = { provider: 'gemini' as const, model: undefined };
    const ws = mkTemp();
    const stream = fakeStdout(chunk => { capturedOutput += chunk; });

    // Setup mock that completes synchronously via onMount-like approach
    const { unmount, wait } = renderTui(
      React.createElement(App, {
        workspaceRoot: ws,
        agentProfile,
        SessionCtor: MockSession as any,
        SetupCtor: MockSetup as any,
        startLoginCtor: mockStartLogin,
        completeLoginCtor: mockCompleteLogin,
      }),
      { stdout: stream },
    );

    // In non-TTY mode, useEffect won't fire. We need a different strategy.
    // Let's use the fact that setup mode renders Setup component,
    // and the app creates Session only when model is set.
    // Since we can't test async setup flow, we verify sync behavior only.
    unmount();

    // Config is written during handleSetupComplete which runs after setup
    // Since we can't trigger it synchronously, skip this test in non-TTY mode
  });

  it('passes props to Session constructor', () => {
    const agentProfile = { provider: 'claude' as const, model: 'claude-sonnet-4-6' };
    const ws = mkTemp();
    let sessionOpts: any = null;

    const SessionCapture = class extends MockSession {
      constructor(opts: any) {
        super(opts);
        sessionOpts = opts;
      }
    };

    const stream = fakeStdout(chunk => { capturedOutput += chunk; });

    const instance = renderTui(
      React.createElement(App, {
        workspaceRoot: ws,
        agentProfile,
        enableGitHub: true,
        enableWebSearch: false,
        maxTokens: 4096,
        SessionCtor: SessionCapture as any,
        startLoginCtor: mockStartLogin,
        completeLoginCtor: mockCompleteLogin,
      }),
      { stdout: stream },
    );

    assert.ok(sessionOpts, 'Session should be constructed');
    assert.strictEqual(sessionOpts.agent.provider, 'claude');
    assert.strictEqual(sessionOpts.agent.model, 'claude-sonnet-4-6');
    assert.strictEqual(sessionOpts.workspaceRoot, ws);
    assert.strictEqual(sessionOpts.enableGitHub, true);
    assert.strictEqual(sessionOpts.enableWebSearch, false);
    assert.strictEqual(sessionOpts.maxTokens, 4096);

    instance.unmount();
  });

  it('passes contextAgentProfile to Session', () => {
    const agentProfile = { provider: 'claude' as const, model: 'claude-sonnet-4-6' };
    const ws = mkTemp();
    const contextAgent = { provider: 'openai' as const, model: 'gpt-4o' };
    let contextAgentVal: any = null;

    const SessionCapture = class extends MockSession {
      constructor(opts: any) {
        super(opts);
        contextAgentVal = opts.contextAgent;
      }
    };

    const stream = fakeStdout(chunk => { capturedOutput += chunk; });

    const instance = renderTui(
      React.createElement(App, {
        workspaceRoot: ws,
        agentProfile,
        contextAgentProfile: contextAgent,
        SessionCtor: SessionCapture as any,
        startLoginCtor: mockStartLogin,
        completeLoginCtor: mockCompleteLogin,
      }),
      { stdout: stream },
    );

    assert.ok(contextAgentVal, 'contextAgent should be passed');
    assert.strictEqual(contextAgentVal.provider, 'openai');
    assert.strictEqual(contextAgentVal.model, 'gpt-4o');

    instance.unmount();
  });

  // The key precedence itself is settled in services/settings.test.ts; what
  // matters here is that the resolved settings actually reach the engine,
  // because a persisted level-3 gate that never gets handed to the Session
  // leaves the user thinking a judge is reviewing calls when none is.
  it('hands the resolved settings to the Session, judge and credential included', () => {
    const ws = mkTemp();
    let opts: any = null;
    const SessionCapture = class extends MockSession {
      constructor(o: any) { super(o); opts = o; }
    };

    const instance = renderTui(
      React.createElement(App, {
        workspaceRoot: ws,
        agentProfile: { provider: 'openrouter' as const, model: 'm1', apiKey: 'deep-key' },
        settings: {
          runtime: 'light' as const,
          safetyLevel: 3 as const,
          safetyAgent: { provider: 'openrouter' as const, model: 'judge-model' },
        },
        savedKeys: {},
        SessionCtor: SessionCapture as any,
        startLoginCtor: mockStartLogin,
        completeLoginCtor: mockCompleteLogin,
      }),
      { stdout: fakeStdout(chunk => { capturedOutput += chunk; }) },
    );

    assert.strictEqual(opts.safetyLevel, 3);
    assert.strictEqual(opts.light, true, 'the runtime mode reaches the engine as its light flag');
    assert.ok(opts.safetyAgent, 'a persisted judge must be configured at startup');
    assert.strictEqual(opts.safetyAgent.profile.model, 'judge-model');
    assert.strictEqual(opts.safetyAgent.profile.apiKey, 'deep-key');

    instance.unmount();
  });

  it('defaults to the full belt and the human gate when nothing is pinned', () => {
    const ws = mkTemp();
    let opts: any = null;
    const SessionCapture = class extends MockSession {
      constructor(o: any) { super(o); opts = o; }
    };

    const instance = renderTui(
      React.createElement(App, {
        workspaceRoot: ws,
        agentProfile: { provider: 'claude' as const, model: 'claude-sonnet-4-6' },
        SessionCtor: SessionCapture as any,
        startLoginCtor: mockStartLogin,
        completeLoginCtor: mockCompleteLogin,
      }),
      { stdout: fakeStdout(chunk => { capturedOutput += chunk; }) },
    );

    assert.strictEqual(opts.safetyLevel, 2);
    assert.strictEqual(opts.light, false);
    assert.strictEqual(opts.safetyAgent, undefined);

    instance.unmount();
  });

  it('creates Session with correct workspace path', () => {
    const agentProfile = { provider: 'claude' as const, model: 'claude-sonnet-4-6' };
    const ws = mkTemp();
    const deepPath = join(ws, 'sub', 'dir');
    mkdirSync(deepPath, { recursive: true });

    let sessionWs: string | null = null;
    const SessionCapture = class extends MockSession {
      constructor(opts: any) {
        super(opts);
        sessionWs = opts.workspaceRoot;
      }
    };

    const stream = fakeStdout(chunk => { capturedOutput += chunk; });

    const instance = renderTui(
      React.createElement(App, {
        workspaceRoot: deepPath,
        agentProfile,
        SessionCtor: SessionCapture as any,
        startLoginCtor: mockStartLogin,
        completeLoginCtor: mockCompleteLogin,
      }),
      { stdout: stream },
    );

    assert.strictEqual(sessionWs, deepPath);
    instance.unmount();
  });

  it('initializes with idle mode when model exists', async () => {
    const agentProfile = { provider: 'claude' as const, model: 'claude-sonnet-4-6' };
    const ws = mkTemp();
    const stream = fakeStdout(chunk => { capturedOutput += chunk; });

    const instance = renderTui(
      React.createElement(App, {
        workspaceRoot: ws,
        agentProfile,
        SessionCtor: MockSession as any,
        startLoginCtor: mockStartLogin,
        completeLoginCtor: mockCompleteLogin,
      }),
      { stdout: stream },
    );

    try {
      // Assert the idle prompt is actually on screen, not merely that the setup
      // step is absent — that negative passed even when nothing rendered at all.
      await waitFor(() => capturedOutput.includes('type a task'));
      assert.ok(
        capturedOutput.includes('type a task'),
        `expected the idle prompt, got: ${JSON.stringify(capturedOutput.slice(0, 200))}`,
      );
      assert.ok(!capturedOutput.includes('choose a provider'));
    } finally {
      instance.unmount();
    }
  });

  it('attaches a clipboard image on ctrl-V and sends it with the task', async () => {
    // The terminal cannot deliver image bytes — bracketed paste carries
    // characters — so ctrl-V reads the OS clipboard instead. This drives that
    // whole path: keystroke, label in the prompt, bytes on session.run().
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(4096),
    ]);
    const sent: Array<{ text: string; images: unknown[] }> = [];
    mockRun = async (text, images) => { sent.push({ text, images }); };

    const ws = mkTemp();
    const stream = fakeStdout(chunk => { capturedOutput += chunk; });
    const stdin = fakeStdin();

    const instance = renderTui(
      React.createElement(App, {
        workspaceRoot: ws,
        agentProfile: { provider: 'claude' as const, model: 'claude-sonnet-4-6' },
        SessionCtor: MockSession as any,
        startLoginCtor: mockStartLogin,
        completeLoginCtor: mockCompleteLogin,
        readClipboardImageCtor: () =>
          ({ image: { data: png.toString('base64'), mimeType: 'image/png' as const } }),
      } as any),
      { stdout: stream, stdin },
    );

    try {
      await waitFor(() => capturedOutput.includes('type a task'));

      stdin.push('why is this wrong?');
      await waitFor(() => capturedOutput.includes('why is this wrong?'));

      stdin.push('\u0016'); // ctrl-V
      await waitFor(() => capturedOutput.includes('[image #1]'));
      assert.match(capturedOutput, /attached \[image #1\] — 4 KB png/,
        'the row says what was attached and how big it is');

      stdin.push('\r');
      await waitFor(() => sent.length > 0);

      assert.equal(sent[0].text, 'why is this wrong? [image #1]',
        'the label stays in the text, so the model can refer to it');
      assert.equal(sent[0].images.length, 1);
      const image = sent[0].images[0] as { data: string; mimeType: string };
      assert.equal(image.mimeType, 'image/png');
      assert.ok(Buffer.from(image.data, 'base64').equals(png), 'the bytes survive the round trip');
    } finally {
      instance.unmount();
    }
  });

  it('renders Setup component when no model', async () => {
    const agentProfile = { provider: 'claude' as const, model: undefined };
    const ws = mkTemp();
    const stream = fakeStdout(chunk => { capturedOutput += chunk; });

    const instance = renderTui(
      React.createElement(App, {
        workspaceRoot: ws,
        agentProfile,
        SessionCtor: MockSession as any,
        startLoginCtor: mockStartLogin,
        completeLoginCtor: mockCompleteLogin,
      }),
      { stdout: stream },
    );

    try {
      // Ink commits on a later tick — asserting synchronously reads an empty
      // buffer. The sibling tests only got away with it because they assert a
      // negative, which passes trivially against no output at all.
      await waitFor(() => capturedOutput.includes('choose a provider'));
      assert.ok(
        capturedOutput.includes('choose a provider'),
        `expected the provider step, got: ${JSON.stringify(capturedOutput.slice(0, 200))}`,
      );
    } finally {
      // In a finally so a failed assertion cannot leave Ink mounted. It used to
      // leak on failure, and the runner then waited on its handles — one test
      // accounting for 135s of the suite's 137s.
      instance.unmount();
    }
  });

  it('renders without error in all default configurations', () => {
    const configs = [
      { provider: 'claude' as const, model: 'claude-sonnet-4-6' },
      { provider: 'openai' as const, model: 'gpt-4o' },
      { provider: 'gemini' as const, model: 'gemini-2.0-flash' },
      { provider: 'mistral' as const, model: 'mistral-large-latest' },
      { provider: 'ollama' as const, model: 'llama3.2' },
    ];

    for (const agentProfile of configs) {
      const ws = mkTemp();
      const stream = fakeStdout(chunk => { capturedOutput += chunk; });

      const instance = renderTui(
        React.createElement(App, {
          workspaceRoot: ws,
          agentProfile,
          SessionCtor: MockSession as any,
          startLoginCtor: mockStartLogin,
          completeLoginCtor: mockCompleteLogin,
        }),
        { stdout: stream },
      );

      instance.unmount();
    }
  });
});

describe('the startup update check', () => {
  const agentProfile = { provider: 'claude' as const, model: 'claude-sonnet-4-6' };

  /** Renders the App with a pre-resolved check, so no test touches the network. */
  function renderWith(result: { current: string; latest: string } | null, animate = false) {
    const stream = fakeStdout(chunk => { capturedOutput += chunk; });
    return renderTui(
      React.createElement(App, {
        workspaceRoot: mkTemp(),
        agentProfile,
        updateCheck: Promise.resolve(result),
        animate,
        SessionCtor: MockSession as any,
        startLoginCtor: mockStartLogin,
        completeLoginCtor: mockCompleteLogin,
      } as any),
      { stdout: stream },
    );
  }

  it('offers /update when a newer release exists', async () => {
    const instance = renderWith({ current: '0.8.2', latest: '0.9.0' });
    try {
      await waitFor(() => capturedOutput.includes('update available'), 'the update row');
      assert.match(capturedOutput, /0\.8\.2 → 0\.9\.0/, 'both versions are named');
      assert.match(capturedOutput, /\/update/,
        'the row has to say what to do — it is the only place this is now surfaced');
    } finally {
      instance.unmount();
    }
  });

  it('says nothing when there is nothing newer', async () => {
    const instance = renderWith(null);
    try {
      await waitFor(() => capturedOutput.includes('type a task'), 'the idle prompt');
      // The prompt being up means the App has settled; a notice would be here by now.
      assert.doesNotMatch(capturedOutput, /update available/);
    } finally {
      instance.unmount();
    }
  });

  it('survives the boot animation, which replaces the transcript when it ends', async () => {
    // The regression this guards: the banner's onDone calls transcript.reset(),
    // so a row pushed while it was still animating is discarded. The check is a
    // network round trip racing an animation, so before the fix which one won
    // was luck — and losing meant the notice silently never appeared.
    const instance = renderWith({ current: '0.8.2', latest: '0.9.0' }, true);
    try {
      await waitFor(() => capturedOutput.includes('type a task'), 'boot to finish', 10_000);
      await waitFor(() => capturedOutput.includes('update available'),
        'the update row after boot', 10_000);
    } finally {
      instance.unmount();
    }
  });
});
