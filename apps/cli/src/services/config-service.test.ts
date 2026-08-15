import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { ConfigService } from './config-service.js';
import { configPath, globalConfigPath, loadConfig, savedDeepProfile, providerCredentials } from './config-store.js';
import type { AgentProfile } from '@agentionai/marshall-engine';

const LOCAL: AgentProfile = { provider: 'llamacpp', model: 'qwen', host: 'http://192.168.1.248:8080' };
const ROUTER: AgentProfile = { provider: 'openrouter', model: 'deepseek/v4', apiKey: 'or-key' };

function ws(): string { return mkdtempSync(join(tmpdir(), 'cfg-svc-')); }
function writeGlobal(contents: unknown): void {
  mkdirSync(dirname(globalConfigPath()), { recursive: true });
  writeFileSync(globalConfigPath(), JSON.stringify(contents));
}
function readGlobal(): any {
  return existsSync(globalConfigPath())
    ? JSON.parse(readFileSync(globalConfigPath(), 'utf8'))
    : {};
}

// Every test gets its own $XDG_CONFIG_HOME so the global config never touches
// the real developer machine, and tests can't see each other's state.
const originalXdg = process.env.XDG_CONFIG_HOME;
beforeEach(() => {
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'xdg-'));
});
afterEach(() => {
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
});

describe('saveProfiles', () => {
  it('round-trips through the reader, via the global config', async () => {
    await new ConfigService(ws()).saveProfiles(ROUTER, LOCAL);
    const back = loadConfig(ws());
    assert.equal(savedDeepProfile(back).model, 'deepseek/v4');
    assert.equal(providerCredentials(back.providers, { provider: 'llamacpp' }).host,
      'http://192.168.1.248:8080');
  });

  it('preserves a provider entry written by an earlier session', async () => {
    writeGlobal({ providers: [{ provider: 'ollama', host: 'http://localhost:11434' }] });
    await new ConfigService(ws()).saveProfiles(ROUTER, undefined);
    assert.equal(providerCredentials(loadConfig(ws()).providers, { provider: 'ollama' }).host,
      'http://localhost:11434');
  });

  it('switching provider keeps the previous provider’s host', async () => {
    const config = new ConfigService(ws());
    await config.saveProfiles(LOCAL, undefined);   // using llama.cpp
    await config.saveProfiles(ROUTER, undefined);  // switch to OpenRouter
    assert.equal(providerCredentials(loadConfig(ws()).providers, { provider: 'llamacpp' }).host,
      'http://192.168.1.248:8080', 'the llama.cpp host must survive the switch');
  });

  it('writes 0600, since the file can hold an API key', async () => {
    await new ConfigService(ws()).saveProfiles(ROUTER, undefined);
    assert.equal(statSync(globalConfigPath()).mode & 0o777, 0o600);
  });

  // `mode` on writeFile only applies when the file is created, so a file that
  // already exists keeps whatever it had — including a loose mode from an older
  // build that wrote it without one.
  it('tightens the mode of a file that already existed', async () => {
    writeGlobal({ providers: [] });
    await new ConfigService(ws()).saveProfiles(ROUTER, undefined);
    assert.equal(statSync(globalConfigPath()).mode & 0o777, 0o600);
  });

  it('leaves the rest of the global file alone', async () => {
    // Choosing a model used to rebuild the file from the tiers alone, which
    // silently deleted every other section — a configured MCP server survived
    // exactly one /model.
    writeGlobal({
      mcpServers: [{ name: 'gh', url: 'https://example.com/mcp', headers: { auth: 't' } }],
      settings: { version: 1, mode: 'light' },
    });
    await new ConfigService(ws()).saveProfiles(ROUTER, undefined);

    const back = readGlobal();
    assert.deepEqual(back.mcpServers, [{ name: 'gh', url: 'https://example.com/mcp', headers: { auth: 't' } }]);
    assert.deepEqual(back.settings, { version: 1, mode: 'light' });
    assert.equal(back.model, 'deepseek/v4', 'and still records the tier it was called with');
  });

  it('recovers from a corrupt existing file instead of throwing', async () => {
    mkdirSync(dirname(globalConfigPath()), { recursive: true });
    writeFileSync(globalConfigPath(), 'not json at all');
    await new ConfigService(ws()).saveProfiles(ROUTER, undefined);
    assert.equal(readGlobal().provider, 'openrouter');
  });

  it('never writes to the project-local override', async () => {
    const root = ws();
    await new ConfigService(root).saveProfiles(ROUTER, undefined);
    assert.equal(existsSync(configPath(root)), false);
  });
});

describe('disk is the source of truth', () => {
  it('re-reads after a write instead of serving the snapshot it already had', async () => {
    const config = new ConfigService(ws());
    assert.deepEqual(config.snapshot().providers, []);

    await config.saveProfiles(ROUTER, undefined);
    assert.equal(config.snapshot().providers.length, 1,
      'the snapshot taken before the write must not survive it');
  });

  it('returns the same snapshot object until something changes', () => {
    const config = new ConfigService(ws());
    assert.equal(config.snapshot(), config.snapshot(),
      'useSyncExternalStore loops if the getter returns a new object each call');
  });

  it('notifies subscribers on a write, and stops after unsubscribe', async () => {
    const config = new ConfigService(ws());
    let notifications = 0;
    const unsubscribe = config.subscribe(() => { notifications += 1; });

    await config.saveProfiles(ROUTER, undefined);
    assert.equal(notifications, 1);

    unsubscribe();
    await config.saveProfiles(LOCAL, undefined);
    assert.equal(notifications, 1, 'an unsubscribed listener must not be called');
  });

  // The removed entry used to stay on screen because the UI held a copy taken
  // at startup: the file changed, the props did not.
  it('a removal is visible in the very next snapshot', async () => {
    writeGlobal({ providers: [
      { provider: 'openai-compatible', host: 'http://plain' },
      { provider: 'openai-compatible', name: 'LM Studio', host: 'http://lm' },
    ] });
    const config = new ConfigService(ws());
    assert.equal(config.snapshot().providers.length, 2);

    await config.removeProvider({ provider: 'openai-compatible', name: 'LM Studio' });
    assert.deepEqual(config.snapshot().providers, [{ provider: 'openai-compatible', host: 'http://plain' }]);
  });
});

describe('one write path', () => {
  // Each writer used to do its own read-modify-write, so two of them starting
  // in the same tick both read the file before either had written it, and
  // whichever finished second wrote its own base back over the other's change.
  it('two writes in the same tick compose instead of clobbering', async () => {
    const config = new ConfigService(ws());
    await Promise.all([
      config.saveMcpServers([{ name: 'gh', url: 'https://example.com/mcp' }]),
      config.updateSettings(current => ({ ...current, runtime: 'light' }), 'global'),
      config.saveProfiles(ROUTER, undefined),
    ]);

    const back = readGlobal();
    assert.equal(back.mcpServers?.length, 1, 'the MCP write survived');
    assert.equal(back.settings?.runtime, 'light', 'the settings write survived');
    assert.equal(back.model, 'deepseek/v4', 'the profile write survived');
  });

  it('reports a failed write rather than swallowing it, and still resolves', async () => {
    // A file where the config *directory* should be: every mkdir under it fails.
    const blocked = join(mkdtempSync(join(tmpdir(), 'blocked-')), 'not-a-dir');
    writeFileSync(blocked, '');
    process.env.XDG_CONFIG_HOME = blocked;

    const errors: string[] = [];
    const config = new ConfigService(ws(), {}, message => errors.push(message));

    // Must not reject: an unhandled rejection here takes the process down, and
    // every call site treats persistence as fire-and-forget.
    await config.saveProfiles(ROUTER, undefined);

    assert.equal(errors.length, 1);
    assert.match(errors[0], /could not save model settings/);
  });

  it('keeps working after a failed write', async () => {
    const blocked = join(mkdtempSync(join(tmpdir(), 'blocked-')), 'not-a-dir');
    writeFileSync(blocked, '');
    const good = process.env.XDG_CONFIG_HOME!;

    const errors: string[] = [];
    const config = new ConfigService(ws(), {}, message => errors.push(message));

    process.env.XDG_CONFIG_HOME = blocked;
    await config.saveProfiles(ROUTER, undefined);
    process.env.XDG_CONFIG_HOME = good;

    // One EACCES used to be enough to wedge the queue for the rest of the
    // session, since every later write chained onto a rejected promise.
    await config.saveProfiles(LOCAL, undefined);
    assert.equal(readGlobal().model, 'qwen');
    assert.equal(errors.length, 1);
  });

  it('redirects errors once the UI has somewhere to put them', async () => {
    const blocked = join(mkdtempSync(join(tmpdir(), 'blocked-')), 'not-a-dir');
    writeFileSync(blocked, '');
    process.env.XDG_CONFIG_HOME = blocked;

    const transcript: string[] = [];
    const config = new ConfigService(ws());
    config.reportErrorsTo(message => transcript.push(message));
    await config.saveProfiles(ROUTER, undefined);

    assert.equal(transcript.length, 1);
  });
});

describe('scope', () => {
  it('writes a project setting to the project file, leaving the global one alone', async () => {
    const root = ws();
    const config = new ConfigService(root);
    await config.updateSettings(current => ({ ...current, runtime: 'light' }));

    assert.equal(JSON.parse(readFileSync(configPath(root), 'utf8')).settings.runtime, 'light');
    assert.equal(readGlobal().settings, undefined);
  });

  it('records an MCP selection in the project file and never its credentials', async () => {
    const root = ws();
    const config = new ConfigService(root);
    await config.enableProjectMcpServer('gh');

    const project = JSON.parse(readFileSync(configPath(root), 'utf8'));
    assert.deepEqual(project.mcp, { enable: ['gh'] });
    assert.equal(project.mcpServers, undefined, 'definitions, and their headers, stay global');
  });

  it('does not repeat a selection it already recorded', async () => {
    const root = ws();
    const config = new ConfigService(root);
    await config.enableProjectMcpServer('gh');
    await config.enableProjectMcpServer('gh');
    assert.deepEqual(JSON.parse(readFileSync(configPath(root), 'utf8')).mcp.enable, ['gh']);
  });
});

describe('credential lookups', () => {
  it('answers for the endpoint asked about, not the provider’s first entry', async () => {
    writeGlobal({ providers: [
      { provider: 'openai-compatible', host: 'http://plain', apiKey: 'plain-key' },
      { provider: 'openai-compatible', name: 'LM Studio', host: 'http://lm', apiKey: 'lm-key' },
    ] });
    const config = new ConfigService(ws());

    assert.deepEqual(config.credentialsFor({ provider: 'openai-compatible', name: 'LM Studio' }),
      { host: 'http://lm', apiKey: 'lm-key' });
    // How the stored judge, which knows a host but never a name, finds its key.
    assert.equal(config.keyFor('openai-compatible', 'http://lm'), 'lm-key');
  });
});
