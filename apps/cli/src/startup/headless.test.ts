import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ClientInterface, EngineConfig, OutputEvent } from '@agentionai/marshall-engine';
import { runHeadless } from './headless.js';
import { parseCliArgs } from './args.js';
import type { CliFlags } from './args.js';
import type { ResolvedProfiles } from './profiles.js';

/** Flags as if nothing was passed, so each test states only what it varies. */
function flags(overrides: Partial<CliFlags> = {}): CliFlags {
  return { ...parseCliArgs([]), message: 'do the task', ...overrides };
}

const profiles: ResolvedProfiles = { agentProfile: { provider: 'claude', model: 'claude-sonnet-4-6' } };

let stderr: string[] = [];
const originalError = console.error;
beforeEach(() => {
  stderr = [];
  console.error = (msg: string) => { stderr.push(msg); };
});
afterEach(() => { console.error = originalError; });

/** Captures the config a run was built with, without touching a real engine. */
class FakeSession {
  static lastConfig: EngineConfig | undefined;
  static lastClient: ClientInterface | undefined;
  static ranWith: string | undefined;
  emit?: (client: ClientInterface) => void;
  constructor(config: EngineConfig, client: ClientInterface) {
    FakeSession.lastConfig = config;
    FakeSession.lastClient = client;
  }
  async run(task: string): Promise<void> {
    FakeSession.ranWith = task;
    if (this.emit) this.emit(FakeSession.lastClient!);
  }
}

describe('runHeadless — safety gate', () => {
  it('refuses to run without --safety', async () => {
    const code = await runHeadless(flags(), '/ws', profiles, FakeSession as any);
    assert.strictEqual(code, 1);
    assert.match(stderr[0], /--safety yolo/);
  });

  it('refuses "default" — it still asks a human', async () => {
    const code = await runHeadless(flags({ safety: 'default' }), '/ws', profiles, FakeSession as any);
    assert.strictEqual(code, 1);
    assert.match(stderr[0], /--safety yolo/);
  });

  it('refuses "agentic" — it still falls back to a human on deny/unclear', async () => {
    const code = await runHeadless(flags({ safety: 'agentic' }), '/ws', profiles, FakeSession as any);
    assert.strictEqual(code, 1);
    assert.match(stderr[0], /--safety yolo/);
  });

  it('refuses an unrecognised word with a distinct message', async () => {
    const code = await runHeadless(flags({ safety: 'bogus' }), '/ws', profiles, FakeSession as any);
    assert.strictEqual(code, 1);
    assert.match(stderr[0], /"bogus" is not a recognised level/);
  });
});

describe('runHeadless — happy path', () => {
  it('builds an engine config at safetyLevel 1 and runs the message', async () => {
    const code = await runHeadless(flags({ safety: 'yolo' }), '/ws', profiles, FakeSession as any);
    assert.strictEqual(code, 0);
    assert.strictEqual(FakeSession.lastConfig?.safetyLevel, 1);
    assert.strictEqual(FakeSession.lastConfig?.workspaceRoot, '/ws');
    assert.strictEqual(FakeSession.lastConfig?.agent, profiles.agentProfile);
    assert.strictEqual(FakeSession.ranWith, 'do the task');
  });

  it('exits 1 when the run reports an error event', async () => {
    class ErroringSession extends FakeSession {
      override emit = (client: ClientInterface) => {
        client.onOutput({ type: 'error', message: 'boom' } as OutputEvent);
      };
    }
    const code = await runHeadless(flags({ safety: 'yolo' }), '/ws', profiles, ErroringSession as any);
    assert.strictEqual(code, 1);
  });

  it('prints a MARSHALL_USAGE line for the final usage event, and only that one', async () => {
    class UsageSession extends FakeSession {
      override emit = (client: ClientInterface) => {
        client.onOutput({
          type: 'usage', durationMs: 10, final: false,
          turn: { inputTokens: 1, outputTokens: 1 }, session: { inputTokens: 1, outputTokens: 1 },
        } as OutputEvent);
        client.onOutput({
          type: 'usage', durationMs: 20, final: true,
          turn: { inputTokens: 100, outputTokens: 40, reasoningTokens: 15 },
          session: { inputTokens: 100, outputTokens: 40, reasoningTokens: 15, costUsd: 0.02 },
        } as OutputEvent);
      };
    }
    const written: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      await runHeadless(flags({ safety: 'yolo' }), '/ws', profiles, UsageSession as any);
    } finally {
      process.stdout.write = originalWrite;
    }
    const usageLines = written.filter(line => line.includes('MARSHALL_USAGE'));
    assert.strictEqual(usageLines.length, 1, 'only the final usage sample should be printed');
    const parsed = JSON.parse(usageLines[0].split('MARSHALL_USAGE ')[1]);
    assert.deepStrictEqual(parsed.session, { inputTokens: 100, outputTokens: 40, reasoningTokens: 15, costUsd: 0.02 });
  });
});
