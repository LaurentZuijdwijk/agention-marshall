import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, statSync, existsSync, readdirSync } from 'node:fs';
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
function writeProject(root: string, contents: unknown): void {
  mkdirSync(dirname(configPath(root)), { recursive: true });
  writeFileSync(configPath(root), JSON.stringify(contents));
}
function readProject(root: string): any {
  return existsSync(configPath(root))
    ? JSON.parse(readFileSync(configPath(root), 'utf8'))
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
  it('round-trips through the reader: model from the project file, credential from the global one', async () => {
    const root = ws();
    await new ConfigService(root).saveProfiles(ROUTER, LOCAL);
    const back = loadConfig(root);
    assert.equal(savedDeepProfile(back).model, 'deepseek/v4');
    assert.equal(providerCredentials(back.providers, { provider: 'llamacpp' }).host,
      'http://192.168.1.248:8080');
  });

  // The whole point: which model a workspace uses must not follow the user to
  // every other repo, unlike the credential that makes it reachable.
  it('does not pin the model choice for a different workspace', async () => {
    const root = ws();
    await new ConfigService(root).saveProfiles(ROUTER, undefined);

    const other = ws();
    assert.equal(savedDeepProfile(loadConfig(other)).model, undefined,
      'a different workspace must not inherit the model this one picked');
    assert.equal(providerCredentials(loadConfig(other).providers, { provider: 'openrouter' }).apiKey, 'or-key',
      'but the credential, being global, is still there for it to use');
  });

  it('records the model selection in the project file, without its key', async () => {
    const root = ws();
    await new ConfigService(root).saveProfiles(ROUTER, undefined);
    const project = readProject(root);
    assert.equal(project.models.deep.model, 'deepseek/v4');
    assert.equal('apiKey' in project.models.deep, false);
  });

  it('preserves a provider entry written by an earlier session', async () => {
    writeGlobal({ providers: [{ provider: 'ollama', host: 'http://localhost:11434' }] });
    const root = ws();
    await new ConfigService(root).saveProfiles(ROUTER, undefined);
    assert.equal(providerCredentials(loadConfig(root).providers, { provider: 'ollama' }).host,
      'http://localhost:11434');
  });

  it('switching provider keeps the previous provider’s host', async () => {
    const config = new ConfigService(ws());
    await config.saveProfiles(LOCAL, undefined);   // using llama.cpp
    await config.saveProfiles(ROUTER, undefined);  // switch to OpenRouter
    assert.equal(providerCredentials(config.snapshot().providers, { provider: 'llamacpp' }).host,
      'http://192.168.1.248:8080', 'the llama.cpp host must survive the switch');
  });

  it('writes the global file at 0600, since it can hold an API key', async () => {
    await new ConfigService(ws()).saveProfiles(ROUTER, undefined);
    assert.equal(statSync(globalConfigPath()).mode & 0o777, 0o600);
  });

  // `mode` on writeFile only applies when the file is created, so a file that
  // already exists keeps whatever it had — including a loose mode from an older
  // build that wrote it without one.
  it('tightens the mode of a global file that already existed', async () => {
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
    assert.equal(back.providers?.[0]?.provider, 'openrouter', 'and still records the credential it was called with');
  });

  it('leaves the rest of the project file alone', async () => {
    const root = ws();
    writeProject(root, { mcp: { enable: ['gh'] } });
    await new ConfigService(root).saveProfiles(ROUTER, undefined);

    const back = readProject(root);
    assert.deepEqual(back.mcp, { enable: ['gh'] });
    assert.equal(back.models.deep.model, 'deepseek/v4');
  });

  it('recovers from a corrupt existing global file instead of throwing', async () => {
    mkdirSync(dirname(globalConfigPath()), { recursive: true });
    writeFileSync(globalConfigPath(), 'not json at all');
    await new ConfigService(ws()).saveProfiles(ROUTER, undefined);
    assert.equal(readGlobal().providers?.[0]?.provider, 'openrouter');
  });

  it('writes the model selection to the project file', async () => {
    const root = ws();
    await new ConfigService(root).saveProfiles(ROUTER, undefined);
    assert.equal(existsSync(configPath(root)), true);
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

  // `mergeProviders` deliberately lets the project file contribute an entry —
  // a shared host with no key, committed for the whole team — and merges it
  // into the same list a global entry appears in. Removal has to reach every
  // file an entry actually lives in, or the part left behind survives the
  // write and comes back on the very next merge while the UI already said it
  // was gone.
  it('removes an entry that lives only in the project file', async () => {
    const root = ws();
    writeProject(root, { providers: [{ provider: 'llamacpp', host: 'http://ci-box:8080' }] });
    const config = new ConfigService(root);
    assert.equal(config.snapshot().providers.length, 1);

    const removed = await config.removeProvider({ provider: 'llamacpp' });
    assert.equal(removed, true);
    assert.deepEqual(config.snapshot().providers, []);
    assert.deepEqual(readProject(root).providers, [], 'the project file itself must lose the entry too');
  });

  it('removes an entry that lives in both files', async () => {
    const root = ws();
    writeGlobal({ providers: [{ provider: 'llamacpp', host: 'http://old-host', apiKey: 'k' }] });
    writeProject(root, { providers: [{ provider: 'llamacpp', host: 'http://ci-box:8080' }] });
    const config = new ConfigService(root);
    // The merged view: project's host wins, global's key survives since the
    // project layer can never supply one.
    assert.deepEqual(config.snapshot().providers, [{ provider: 'llamacpp', host: 'http://ci-box:8080', apiKey: 'k' }]);

    await config.removeProvider({ provider: 'llamacpp' });
    assert.deepEqual(config.snapshot().providers, []);
    assert.deepEqual(readGlobal().providers, [], 'left in the global file, it would reappear on the next merge');
    assert.deepEqual(readProject(root).providers, [], 'left in the project file, it would reappear on the next merge');
  });

  it('does not create a project config file for an entry that only ever lived in the global one', async () => {
    const root = ws();
    writeGlobal({ providers: [{ provider: 'llamacpp', host: 'http://box' }] });
    const config = new ConfigService(root);

    await config.removeProvider({ provider: 'llamacpp' });
    assert.equal(existsSync(configPath(root)), false,
      'a scope the entry never touched must not be written at all');
  });

  it('reports false and touches nothing for an entry that exists nowhere', async () => {
    const root = ws();
    writeGlobal({ providers: [{ provider: 'llamacpp', host: 'http://box' }] });
    const config = new ConfigService(root);

    const removed = await config.removeProvider({ provider: 'openrouter' });
    assert.equal(removed, false);
    assert.deepEqual(config.snapshot().providers, [{ provider: 'llamacpp', host: 'http://box' }]);
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
    assert.equal(back.providers?.[0]?.provider, 'openrouter', 'the credential write survived');
  });

  it('reports a failed write rather than swallowing it, and still resolves', async () => {
    // A file where the config *directory* should be: every mkdir under it fails.
    // Only the global write goes under $XDG_CONFIG_HOME — the project write, in
    // the workspace's own temp dir, is unaffected and still succeeds.
    const blocked = join(mkdtempSync(join(tmpdir(), 'blocked-')), 'not-a-dir');
    writeFileSync(blocked, '');
    process.env.XDG_CONFIG_HOME = blocked;

    const errors: string[] = [];
    const config = new ConfigService(ws(), {}, message => errors.push(message));

    // Must not reject: an unhandled rejection here takes the process down, and
    // every call site treats persistence as fire-and-forget.
    await config.saveProfiles(ROUTER, undefined);

    assert.equal(errors.length, 1);
    assert.match(errors[0], /could not save provider credentials/);
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
    assert.equal(readGlobal().providers?.some((p: { provider: string }) => p.provider === 'llamacpp'), true);
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

  it('writes the named-agent roster to the project file, leaving the global one alone', async () => {
    const root = ws();
    const config = new ConfigService(root);
    const tester = { name: 'tester', provider: 'claude', model: 'claude-haiku-4-5', description: 'writes tests' };
    await config.saveAgents([tester]);

    assert.deepEqual(JSON.parse(readFileSync(configPath(root), 'utf8')).agents, [tester]);
    assert.equal(readGlobal().agents, undefined);
    assert.deepEqual(config.snapshot().agents, [tester]);
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

describe('concurrent writers', () => {
  // The queue only serialises this process. Another marshall instance (or a
  // hand edit) writes straight to the file, so a save must notice the file
  // changed under it and re-apply its transform to the fresh content — which
  // keeps the other writer's entry instead of clobbering it.
  it('re-applies the transform when another writer lands between read and write', async () => {
    const root = ws();
    const config = new ConfigService(root);
    await config.saveProfiles(LOCAL, undefined);

    const other = { provider: 'claude', apiKey: 'claude-key' };
    let first = true;
    // The stand-in for the other instance: a write straight to the global
    // file, fired from inside our own transform — i.e. exactly between the
    // service's read and its write.
    await config.updateSettings(current => {
      if (first) {
        first = false;
        const global = readGlobal();
        writeGlobal({ ...global, providers: [...(global.providers ?? []), other] });
      }
      return { ...current, runtime: 'standard' as const };
    }, 'global');

    const global = readGlobal();
    assert.deepEqual(global.providers, [
      { provider: 'llamacpp', host: 'http://192.168.1.248:8080' },
      other,
    ], 'both writers landed: the other instance is not clobbered, ours is not lost');
    assert.equal(global.settings?.runtime, 'standard');
  });

  it('gives up with a reported error when the file keeps changing, rather than clobbering', async () => {
    const root = ws();
    const errors: string[] = [];
    const config = new ConfigService(root, {}, message => errors.push(message));
    writeGlobal({ providers: [] });

    // A field that survives the lenient parser — the fingerprint is over the
    // parsed config, so a change it would strip (an unknown key, formatting)
    // is not a change at all, and must not trigger a retry.
    let n = 0;
    const ok = await config.updateSettings(current => {
      n++;
      writeGlobal({ providers: [{ provider: 'claude', apiKey: `k-${n}` }] });
      return current;
    }, 'global');

    assert.equal(ok, false);
    assert.match(errors[0], /keeps changing/);
    assert.equal(readGlobal().providers[0].provider, 'claude',
      "the file holds the other writer's content, not a stale ours");
  });
});

describe('atomic writes', () => {
  it('leaves no temp file behind after a write', async () => {
    const root = ws();
    await new ConfigService(root).saveProfiles(ROUTER, undefined);
    assert.deepEqual(readdirSync(dirname(globalConfigPath())).filter(f => f.includes('.tmp')), []);
  });

  // The strict write schema: the app produced this value, so a local provider
  // with no host is a bug to report, not an entry to file away.
  it('refuses to persist a provider entry the strict schema rejects', async () => {
    const root = ws();
    const errors: string[] = [];
    const config = new ConfigService(root, {}, message => errors.push(message));

    const broken: AgentProfile = { provider: 'llamacpp', model: 'qwen' };
    const ok = await config.saveProfiles(broken, undefined);

    assert.equal(ok, false);
    assert.match(errors[0], /llamacpp needs a host/);
    assert.equal(readGlobal().providers, undefined, 'the global file was not written');
    assert.equal(existsSync(configPath(root)), false, 'nor was a project file created out of nothing');
  });
});

describe('refresh', () => {
  // Display data re-reads on demand; what the session runs on stays pinned.
  // This is the display half: a change made outside the process is invisible
  // to the memo until something asks for the current truth.
  it('picks up a change made outside the process', async () => {
    const root = ws();
    const config = new ConfigService(root);
    await config.saveProfiles(LOCAL, undefined);
    assert.equal(config.snapshot().providers.length, 1);

    const global = readGlobal();
    writeGlobal({ ...global, providers: [...(global.providers ?? []), { provider: 'claude', apiKey: 'k' }] });
    assert.equal(config.snapshot().providers.length, 1, 'the memo still holds what this process last saw');

    config.refresh();
    assert.equal(config.snapshot().providers.length, 2, 'refresh re-reads the file');
  });
});
