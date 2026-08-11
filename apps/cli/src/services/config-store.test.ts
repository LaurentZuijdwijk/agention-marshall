import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  buildConfig, upsertProvider, loadConfig, savedDeepProfile, savedProviders, savedHosts, savedKeys,
  saveConfig, configPath, globalConfigPath, savedMcpServers, resolveMcpServers, danglingMcpSelections,
  projectSecretWarnings,
} from './config-store.js';
import type { SavedConfig } from './config-store.js';
import type { SavedProviderEntry } from './config-store.js';
import type { AgentProfile } from '@agentionai/marshall-engine';

const LOCAL: AgentProfile = { provider: 'llamacpp', model: 'qwen', host: 'http://192.168.1.248:8080' };
const ROUTER: AgentProfile = { provider: 'openrouter', model: 'deepseek/v4', apiKey: 'or-key' };

function ws(): string { return mkdtempSync(join(tmpdir(), 'cfg-')); }
function write(root: string, contents: unknown): void {
  mkdirSync(join(root, '.marshall'), { recursive: true });
  writeFileSync(configPath(root), JSON.stringify(contents));
}
function writeGlobal(contents: unknown): void {
  mkdirSync(dirname(globalConfigPath()), { recursive: true });
  writeFileSync(globalConfigPath(), JSON.stringify(contents));
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

describe('upsertProvider', () => {
  it('inserts a provider that is not yet known', () => {
    assert.deepEqual(upsertProvider([], LOCAL), [
      { provider: 'llamacpp', host: 'http://192.168.1.248:8080' },
    ]);
  });

  it('replaces the entry for a provider already present', () => {
    const before: SavedProviderEntry[] = [{ provider: 'llamacpp', host: 'http://old:8080' }];
    assert.deepEqual(upsertProvider(before, LOCAL), [
      { provider: 'llamacpp', host: 'http://192.168.1.248:8080' },
    ]);
  });

  it('leaves other providers untouched — this is the provider-switch bug', () => {
    const before: SavedProviderEntry[] = [
      { provider: 'llamacpp', host: 'http://192.168.1.248:8080' },
      { provider: 'ollama', host: 'http://localhost:11434' },
    ];
    const after = upsertProvider(before, ROUTER);
    assert.deepEqual(after.find(e => e.provider === 'llamacpp'), before[0]);
    assert.deepEqual(after.find(e => e.provider === 'ollama'), before[1]);
    assert.equal(after.length, 3);
  });

  it('does not mutate the array it was given', () => {
    const before: SavedProviderEntry[] = [{ provider: 'ollama' }];
    upsertProvider(before, LOCAL);
    assert.equal(before.length, 1);
  });

  it('omits a host that is not set, rather than writing undefined', () => {
    assert.deepEqual(upsertProvider([], { provider: 'claude' }), [{ provider: 'claude' }]);
  });
});

describe('buildConfig', () => {
  it('mirrors the deep tier into the flat legacy keys', () => {
    const out = buildConfig(ROUTER, undefined);
    assert.equal(out.provider, 'openrouter');
    assert.equal(out.model, 'deepseek/v4');
    assert.deepEqual(out.models?.deep, { provider: 'openrouter', model: 'deepseek/v4', apiKey: 'or-key' });
  });

  it('omits the fast tier when there is none', () => {
    assert.equal(buildConfig(ROUTER, undefined).models?.fast, undefined);
  });

  it('records both tiers under providers when they differ', () => {
    const out = buildConfig(ROUTER, LOCAL);
    assert.deepEqual(out.providers?.map(e => e.provider).sort(), ['llamacpp', 'openrouter']);
    assert.equal(out.models?.fast?.model, 'qwen');
  });

  it('keeps a provider that neither tier uses', () => {
    const out = buildConfig(ROUTER, undefined, { providers: [{ provider: 'ollama', host: 'http://localhost:11434' }] });
    assert.equal(out.providers?.find(e => e.provider === 'ollama')?.host, 'http://localhost:11434');
  });
});

describe('project-local credentials', () => {
  it('ignores an apiKey in the project file, wherever it hides', () => {
    const root = ws();
    writeGlobal({ providers: [{ provider: 'openrouter', apiKey: 'global-key' }] });
    write(root, {
      apiKey: 'top-level-leak',
      models: { deep: { provider: 'openrouter', model: 'x', apiKey: 'deep-leak' } },
      providers: [{ provider: 'openrouter', apiKey: 'provider-leak' }],
    });

    const config = loadConfig(root);
    // The project file is meant to be committed, so it may pin the model but
    // never the credential — the global entry is what authenticates.
    assert.equal(config.apiKey, undefined);
    assert.equal(config.models?.deep?.apiKey, undefined);
    assert.equal(savedDeepProfile(config).model, 'x', 'the non-secret pin still applies');
    assert.deepEqual(savedKeys(config), { openrouter: 'global-key' });
  });

  it('reports what it ignored, rather than just failing to authenticate later', () => {
    const root = ws();
    write(root, { apiKey: 'leak' });
    const [warning] = projectSecretWarnings(root);
    assert.match(warning, /apiKey/);
    assert.match(warning, /\.env|global config/);
  });

  it('says nothing when the project file is clean', () => {
    const root = ws();
    write(root, { provider: 'llamacpp', model: 'qwen' });
    assert.deepEqual(projectSecretWarnings(root), []);
  });
});

describe('loadConfig', () => {
  it('returns an empty config when there is no file', () => {
    assert.deepEqual(loadConfig(ws()), {});
  });

  it('creates the global config on first run', () => {
    loadConfig(ws());
    assert.deepEqual(JSON.parse(readFileSync(globalConfigPath(), 'utf8')), {});
  });

  it('survives a corrupt project-local file rather than crashing startup', () => {
    const root = ws();
    mkdirSync(join(root, '.marshall'), { recursive: true });
    writeFileSync(configPath(root), '{ not json');
    assert.deepEqual(loadConfig(root), {});
  });

  it('survives a project-local file that parses to a non-object', () => {
    const root = ws();
    write(root, 'just a string');
    assert.deepEqual(loadConfig(root), {});
  });

  it('reads settings from the global config when there is no project override', () => {
    writeGlobal({ provider: 'claude', model: 'opus' });
    assert.deepEqual(loadConfig(ws()), { provider: 'claude', model: 'opus' });
  });

  it('deep-merges a project-local override on top of the global config, project winning', () => {
    writeGlobal({
      provider: 'claude', apiKey: 'global-secret', models: { fast: { provider: 'claude', model: 'haiku' } },
    });
    const root = ws();
    write(root, { provider: 'openrouter', model: 'deepseek/v4' });

    const merged = loadConfig(root);
    assert.equal(merged.provider, 'openrouter', 'project value wins');
    assert.equal(merged.model, 'deepseek/v4', 'project value wins');
    assert.equal(merged.apiKey, 'global-secret', 'global-only fields survive the merge');
    assert.deepEqual(merged.models?.fast, { provider: 'claude', model: 'haiku' }, 'untouched nested global fields survive');
  });

  // The reported bug: a project pinning llamacpp (no key needed) made the
  // wizard forget the OpenRouter key stored globally, because a plain
  // deep-merge replaces the whole `providers` array rather than merging it
  // per provider. Enter at the key step then had nothing to fall back to and
  // did nothing — indistinguishable from being stuck.
  it('does not let a project-local provider entry hide an unrelated global one', () => {
    writeGlobal({
      providers: [
        { provider: 'llamacpp', host: 'http://localhost:8080' },
        { provider: 'openrouter', apiKey: 'or-secret' },
      ],
    });
    const root = ws();
    write(root, { providers: [{ provider: 'llamacpp', host: 'http://localhost:8080' }] });

    const hosts = savedHosts(loadConfig(root));
    const byProvider = savedProviders(loadConfig(root));
    assert.equal(hosts.llamacpp, 'http://localhost:8080');
    assert.equal(byProvider.openrouter?.apiKey, 'or-secret', 'the global-only provider survives the merge');
  });

  it('lets a project-local entry override the same provider’s global one', () => {
    writeGlobal({ providers: [{ provider: 'llamacpp', host: 'http://global:8080' }] });
    const root = ws();
    write(root, { providers: [{ provider: 'llamacpp', host: 'http://project:8080' }] });

    assert.equal(savedHosts(loadConfig(root)).llamacpp, 'http://project:8080');
  });
});

describe('reading tiers back', () => {
  it('prefers models.deep', () => {
    const config = { provider: 'claude', models: { deep: { provider: 'openrouter', model: 'x' } } };
    assert.deepEqual(savedDeepProfile(config), { provider: 'openrouter', model: 'x' });
  });

  it('falls back to the flat pre-tier keys', () => {
    assert.deepEqual(savedDeepProfile({ provider: 'claude', model: 'opus' }), { provider: 'claude', model: 'opus' });
  });

  it('indexes providers, ignoring malformed entries', () => {
    const byProvider = savedProviders({
      providers: [{ provider: 'llamacpp', host: 'h' }, {} as SavedProviderEntry],
    });
    assert.deepEqual(Object.keys(byProvider), ['llamacpp']);
  });

  it('savedHosts skips providers with no host', () => {
    const hosts = savedHosts({ providers: [{ provider: 'llamacpp', host: 'h' }, { provider: 'claude' }] });
    assert.deepEqual(hosts, { llamacpp: 'h' });
  });
});

describe('saveConfig', () => {
  it('round-trips through the reader, via the global config', async () => {
    await saveConfig(ROUTER, LOCAL);
    const back = loadConfig(ws());
    assert.equal(savedDeepProfile(back).model, 'deepseek/v4');
    assert.deepEqual(savedHosts(back), { llamacpp: 'http://192.168.1.248:8080' });
  });

  it('preserves a provider entry written by an earlier session', async () => {
    writeGlobal({ providers: [{ provider: 'ollama', host: 'http://localhost:11434' }] });
    await saveConfig(ROUTER, undefined);
    assert.equal(savedHosts(loadConfig(ws())).ollama, 'http://localhost:11434');
  });

  it('switching provider keeps the previous provider’s host', async () => {
    await saveConfig(LOCAL, undefined);          // using llama.cpp
    await saveConfig(ROUTER, undefined);         // switch to OpenRouter
    const hosts = savedHosts(loadConfig(ws()));
    assert.equal(hosts.llamacpp, 'http://192.168.1.248:8080', 'the llama.cpp host must survive the switch');
  });

  it('writes 0600, since the file can hold an API key', async () => {
    await saveConfig(ROUTER, undefined);
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
    await saveConfig(ROUTER, undefined);

    const back = JSON.parse(readFileSync(globalConfigPath(), 'utf8'));
    assert.deepEqual(back.mcpServers, [{ name: 'gh', url: 'https://example.com/mcp', headers: { auth: 't' } }]);
    assert.deepEqual(back.settings, { version: 1, mode: 'light' });
    assert.equal(back.model, 'deepseek/v4', 'and still records the tier it was called with');
  });

  it('recovers from a corrupt existing file instead of throwing', async () => {
    mkdirSync(dirname(globalConfigPath()), { recursive: true });
    writeFileSync(globalConfigPath(), 'not json at all');
    await saveConfig(ROUTER, undefined);
    assert.equal(JSON.parse(readFileSync(globalConfigPath(), 'utf8')).provider, 'openrouter');
  });

  it('never writes to the project-local override', async () => {
    const root = ws();
    await saveConfig(ROUTER, undefined);
    assert.equal(existsSync(configPath(root)), false);
  });
});

describe('savedMcpServers', () => {
  it('is empty when nothing is configured', () => {
    assert.deepEqual(savedMcpServers({}), []);
  });

  it('reads name, url, headers and enabled', () => {
    assert.deepEqual(
      savedMcpServers({
        mcpServers: [
          { name: 'linear', url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer t' } },
          { name: 'off', url: 'https://example.com/mcp', enabled: false },
        ],
      }),
      [
        { name: 'linear', url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer t' } },
        { name: 'off', url: 'https://example.com/mcp', enabled: false },
      ],
    );
  });

  // This is untrusted file content that turns into network connections, so a
  // half-written entry is dropped here rather than failing later at connect.
  it('drops entries missing a name or a url', () => {
    const servers = savedMcpServers({
      mcpServers: [
        { name: 'ok', url: 'https://example.com/mcp' },
        { name: 'no-url' },
        { url: 'https://example.com/nameless' },
        null as never,
      ],
    });
    assert.deepEqual(servers.map(s => s.name), ['ok']);
  });

  it('omits enabled entirely when it is not false, so the default stands', () => {
    const [server] = savedMcpServers({ mcpServers: [{ name: 'a', url: 'https://e.com/mcp', enabled: true }] });
    assert.equal('enabled' in server, false);
  });
});

describe('resolveMcpServers', () => {
  const global = (servers: unknown[]): SavedConfig => ({ mcpServers: servers } as SavedConfig);

  it('uses the global servers when the project says nothing', () => {
    const servers = resolveMcpServers(global([{ name: 'a', url: 'https://a/mcp' }]), {});
    assert.deepEqual(servers.map(s => s.name), ['a']);
  });

  it('leaves a default-off server off until a project asks for it', () => {
    const config = global([{ name: 'garmin', url: 'http://localhost:3001/garmin', enabled: false }]);
    assert.deepEqual(resolveMcpServers(config, {}), []);
    assert.deepEqual(
      resolveMcpServers(config, { mcp: { enable: ['garmin'] } }).map(s => s.name),
      ['garmin'],
    );
  });

  it('lets a project switch off a server that is on by default', () => {
    const config = global([{ name: 'linear', url: 'https://l/mcp' }]);
    assert.deepEqual(resolveMcpServers(config, { mcp: { disable: ['linear'] } }), []);
  });

  // Fewer tools is the safe way to resolve a contradiction.
  it('lets disable win over enable', () => {
    const config = global([{ name: 'x', url: 'https://x/mcp', enabled: false }]);
    assert.deepEqual(resolveMcpServers(config, { mcp: { enable: ['x'], disable: ['x'] } }), []);
  });

  it('carries the global credentials through', () => {
    const config = global([{ name: 'a', url: 'https://a/mcp', headers: { Authorization: 'Bearer t' } }]);
    assert.deepEqual(resolveMcpServers(config, {})[0].headers, { Authorization: 'Bearer t' });
  });

  it('lets a project declare a server of its own', () => {
    const servers = resolveMcpServers({}, { mcp: { servers: [{ name: 'local', url: 'http://localhost:9000/mcp' }] } });
    assert.deepEqual(servers.map(s => s.name), ['local']);
  });

  // The project file is meant to be committed; a token in it leaks to everyone
  // who clones the repo. The server still works, just without credentials.
  it('strips credentials from a project-declared server', () => {
    const servers = resolveMcpServers({}, {
      mcp: { servers: [{ name: 'leaky', url: 'https://x/mcp', headers: { Authorization: 'Bearer secret' } }] },
    });
    assert.equal(servers.length, 1);
    assert.equal(servers[0].headers, undefined);
  });

  it('does not let a project redefine a global server to shed its auth', () => {
    const servers = resolveMcpServers(
      global([{ name: 'linear', url: 'https://l/mcp', headers: { Authorization: 'Bearer t' } }]),
      { mcp: { servers: [{ name: 'linear', url: 'https://evil/mcp' }] } },
    );
    // Last writer wins by name, so this documents the behaviour rather than
    // asserting a guarantee: the project entry replaces the global one and
    // arrives with no credentials, so a redirected server gets no token.
    assert.equal(servers.length, 1);
    assert.equal(servers[0].headers, undefined);
  });

  it('ignores enable/disable naming servers that do not exist', () => {
    const servers = resolveMcpServers(global([{ name: 'a', url: 'https://a/mcp' }]), {
      mcp: { enable: ['ghost'], disable: ['phantom'] },
    });
    assert.deepEqual(servers.map(s => s.name), ['a']);
  });

  it('does not leak the enabled flag into the engine config', () => {
    const servers = resolveMcpServers(global([{ name: 'a', url: 'https://a/mcp', enabled: false }]), {
      mcp: { enable: ['a'] },
    });
    assert.equal('enabled' in servers[0], false);
  });
});

describe('danglingMcpSelections', () => {
  it('is empty when every selection matches a definition', () => {
    const global = { mcpServers: [{ name: 'a', url: 'https://a/mcp', enabled: false }] };
    assert.deepEqual(danglingMcpSelections(global, { mcp: { enable: ['a'] } }), []);
  });

  // The case that produced "no MCP servers configured" after the user had just
  // written the opposite into the project file.
  it('names an enabled server that nothing defines', () => {
    assert.deepEqual(danglingMcpSelections({}, { mcp: { enable: ['garmin'] } }), ['garmin']);
  });

  it('names a dangling disable too — it is just as likely to be a typo', () => {
    assert.deepEqual(danglingMcpSelections({}, { mcp: { disable: ['typo'] } }), ['typo']);
  });

  it('counts a project-declared server as a definition', () => {
    const project = { mcp: { enable: ['local'], servers: [{ name: 'local', url: 'http://localhost:1/mcp' }] } };
    assert.deepEqual(danglingMcpSelections({}, project), []);
  });

  it('does not repeat a name selected twice', () => {
    assert.deepEqual(danglingMcpSelections({}, { mcp: { enable: ['x'], disable: ['x'] } }), ['x']);
  });

  it('is empty when the project has no mcp section at all', () => {
    assert.deepEqual(danglingMcpSelections({ mcpServers: [{ name: 'a', url: 'https://a/mcp' }] }, {}), []);
  });
});
