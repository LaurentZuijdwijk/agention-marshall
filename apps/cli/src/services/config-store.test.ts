import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  withAgents, withModelSelection, withProviderCredentials, upsertProvider, loadConfig, savedDeepProfile,
  findProvider, providerCredentials, providerKeyForHost, configPath, globalConfigPath, savedMcpServers,
  resolveMcpServers, danglingMcpSelections, projectSecretWarnings, legacyProfileWarnings, removeProvider,
} from './config-store.js';
import type { SavedConfig } from './config-store.js';
import type { SavedAgentEntry, SavedProviderEntry } from './config-store.js';
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

  it('keys named endpoints independently within one provider', () => {
    const first = { provider: 'openai-compatible', name: 'LM Studio', host: 'http://lm' } as AgentProfile;
    const second = { provider: 'openai-compatible', name: 'Ollama', host: 'http://ollama' } as AgentProfile;
    const out = upsertProvider(upsertProvider([], first), second);
    assert.deepEqual(out.map(e => e.name), ['LM Studio', 'Ollama']);
  });
});

describe('removeProvider', () => {
  const entries = (): SavedProviderEntry[] => [
    { provider: 'claude' },
    { provider: 'llamacpp', host: 'http://192.168.1.248:8080' },
    { provider: 'openai-compatible', name: 'LM Studio', host: 'http://lm' },
    { provider: 'openai-compatible', name: 'Ollama', host: 'http://ollama' },
  ];

  it('removes an unnamed entry', () => {
    const out = removeProvider(entries(), { provider: 'llamacpp' });
    assert.deepEqual(out.map(e => e.provider), ['claude', 'openai-compatible', 'openai-compatible']);
  });

  it('removes only the named endpoint, keeping its other-named siblings', () => {
    const out = removeProvider(entries(), { provider: 'openai-compatible', name: 'LM Studio' });
    assert.deepEqual(out, [
      { provider: 'claude' },
      { provider: 'llamacpp', host: 'http://192.168.1.248:8080' },
      { provider: 'openai-compatible', name: 'Ollama', host: 'http://ollama' },
    ]);
  });

  it('keeps an entry with the same provider but a different name', () => {
    const out = removeProvider(entries(), { provider: 'openai-compatible', name: 'Ollama' });
    assert.equal(out.some(e => e.name === 'LM Studio'), true);
    assert.equal(out.some(e => e.name === 'Ollama'), false);
  });

  // Comparing provider and name as two separate conditions reads as though it
  // does this and does not: with no name to match, every entry sharing the
  // provider matched, so deleting the bare endpoint deleted the named ones too.
  it('removing an unnamed entry leaves the named endpoints on that provider', () => {
    const before = [
      { provider: 'openai-compatible', host: 'http://plain' },
      { provider: 'openai-compatible', name: 'LM Studio', host: 'http://lm' },
    ];
    assert.deepEqual(removeProvider(before, { provider: 'openai-compatible' }), [
      { provider: 'openai-compatible', name: 'LM Studio', host: 'http://lm' },
    ]);
  });

  it('does not mutate the array it was given', () => {
    const before = entries();
    removeProvider(before, { provider: 'openai-compatible', name: 'LM Studio' });
    assert.equal(before.length, 4);
  });
});

describe('providerCredentials', () => {
  const entries = [
    { provider: 'openai-compatible', host: 'http://plain', apiKey: 'plain-key' },
    { provider: 'openai-compatible', name: 'LM Studio', host: 'http://lm', apiKey: 'lm-key' },
    { provider: 'openai-compatible', name: 'Fresh' },
  ];

  it('finds the named endpoint rather than the provider’s first entry', () => {
    assert.deepEqual(providerCredentials(entries, { provider: 'openai-compatible', name: 'LM Studio' }),
      { host: 'http://lm', apiKey: 'lm-key' });
  });

  it('seeds a new endpoint’s host from the unnamed entry, to save retyping it', () => {
    assert.equal(providerCredentials(entries, { provider: 'openai-compatible', name: 'Fresh' }).host,
      'http://plain');
  });

  // A different endpoint name is a different server. Handing it a key stored for
  // another one sends that credential somewhere it was never issued for.
  it('never falls back to another endpoint’s key', () => {
    assert.equal(providerCredentials(entries, { provider: 'openai-compatible', name: 'Fresh' }).apiKey,
      undefined);
  });
});

describe('providerKeyForHost', () => {
  const entries = [
    { provider: 'openai-compatible', apiKey: 'plain-key' },
    { provider: 'openai-compatible', name: 'LM Studio', host: 'http://lm', apiKey: 'lm-key' },
  ];

  // The stored judge records provider and host but never an endpoint name, so
  // this is the only way it can find the key belonging to a named endpoint.
  it('matches a named endpoint by host', () => {
    assert.equal(providerKeyForHost(entries, 'openai-compatible', 'http://lm'), 'lm-key');
  });

  it('falls back to the unnamed entry when no host matches', () => {
    assert.equal(providerKeyForHost(entries, 'openai-compatible', 'http://elsewhere'), 'plain-key');
  });

  it('does not guess between named endpoints', () => {
    const named = [{ provider: 'openai-compatible', name: 'LM Studio', host: 'http://lm', apiKey: 'lm-key' }];
    assert.equal(providerKeyForHost(named, 'openai-compatible', 'http://elsewhere'), undefined);
  });
});

describe('withModelSelection', () => {
  it('records the deep tier, without its key', () => {
    const out = withModelSelection({}, ROUTER, undefined);
    assert.deepEqual(out.models?.deep, { provider: 'openrouter', model: 'deepseek/v4' });
  });

  // The project file is meant to be committed — see AGENTS.md. A key that
  // slipped through here would be a leak for everyone who clones the repo.
  it('never includes the apiKey, even though the profile has one', () => {
    const out = withModelSelection({}, ROUTER, LOCAL);
    assert.equal('apiKey' in (out.models?.deep ?? {}), false);
    assert.equal('apiKey' in (out.models?.fast ?? {}), false);
  });

  it('omits the fast tier when there is none', () => {
    assert.equal(withModelSelection({}, ROUTER, undefined).models?.fast, undefined);
  });

  it('records both tiers', () => {
    const out = withModelSelection({}, ROUTER, LOCAL);
    assert.equal(out.models?.deep?.model, 'deepseek/v4');
    assert.equal(out.models?.fast?.model, 'qwen');
  });

  it('leaves the rest of the file alone', () => {
    const out = withModelSelection({ mcpServers: [{ name: 'gh', url: 'https://example.com/mcp' }] }, ROUTER, undefined);
    assert.deepEqual(out.mcpServers, [{ name: 'gh', url: 'https://example.com/mcp' }]);
  });
});

describe('withProviderCredentials', () => {
  it('records the deep tier’s credential', () => {
    const out = withProviderCredentials({}, ROUTER, undefined);
    assert.deepEqual(out.providers, [{ provider: 'openrouter', apiKey: 'or-key' }]);
  });

  it('records both tiers under providers when they differ', () => {
    const out = withProviderCredentials({}, ROUTER, LOCAL);
    assert.deepEqual(out.providers?.map(e => e.provider).sort(), ['llamacpp', 'openrouter']);
  });

  it('keeps a provider that neither tier uses', () => {
    const out = withProviderCredentials(
      { providers: [{ provider: 'ollama', host: 'http://localhost:11434' }] }, ROUTER, undefined,
    );
    assert.equal(out.providers?.find(e => e.provider === 'ollama')?.host, 'http://localhost:11434');
  });

  it('does not touch the model selection', () => {
    const out = withProviderCredentials({ models: { deep: { provider: 'claude', model: 'opus' } } }, ROUTER, undefined);
    assert.deepEqual(out.models, { deep: { provider: 'claude', model: 'opus' } });
  });
});

describe('withAgents', () => {
  const tester: SavedAgentEntry = {
    name: 'tester', provider: 'claude', model: 'claude-haiku-4-5', description: 'writes and runs unit tests',
  };

  it('records the given agents', () => {
    const out = withAgents({}, [tester]);
    assert.deepEqual(out.agents, [tester]);
  });

  it('replaces the whole list rather than merging', () => {
    const out = withAgents({ agents: [tester] }, []);
    assert.deepEqual(out.agents, []);
  });

  it('leaves the rest of the file alone', () => {
    const out = withAgents({ mcpServers: [{ name: 'gh', url: 'https://example.com/mcp' }] }, [tester]);
    assert.deepEqual(out.mcpServers, [{ name: 'gh', url: 'https://example.com/mcp' }]);
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
    assert.equal(providerCredentials(config.providers, { provider: 'openrouter' }).apiKey, 'global-key');
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

    const config = loadConfig(root);
    assert.equal(providerCredentials(config.providers, { provider: 'llamacpp' }).host, 'http://localhost:8080');
    assert.equal(findProvider(config.providers, { provider: 'openrouter' })?.apiKey, 'or-secret',
      'the global-only provider survives the merge');
  });

  it('lets a project-local entry override the same provider’s global one', () => {
    writeGlobal({ providers: [{ provider: 'llamacpp', host: 'http://global:8080' }] });
    const root = ws();
    write(root, { providers: [{ provider: 'llamacpp', host: 'http://project:8080' }] });

    assert.equal(providerCredentials(loadConfig(root).providers, { provider: 'llamacpp' }).host,
      'http://project:8080');
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

  it('ignores malformed entries when looking one up', () => {
    const entries = [{} as SavedProviderEntry, { provider: 'llamacpp', host: 'h' }];
    assert.deepEqual(findProvider(entries, { provider: 'llamacpp' }), { provider: 'llamacpp', host: 'h' });
    assert.equal(findProvider(entries, { provider: 'claude' }), undefined);
  });

  it('reports no host for a provider that has none stored', () => {
    const entries = [{ provider: 'llamacpp', host: 'h' }, { provider: 'claude' }];
    assert.equal(providerCredentials(entries, { provider: 'claude' }).host, undefined);
  });
});

describe('legacyProfileWarnings', () => {
  it('warns when a model is only in the flat pre-tier shape', () => {
    const warnings = legacyProfileWarnings({ provider: 'claude', model: 'opus' });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /run \/model/);
  });

  it('says nothing once a workspace has re-saved in the tiered shape', () => {
    assert.deepEqual(
      legacyProfileWarnings({ provider: 'claude', model: 'opus', models: { deep: { provider: 'claude', model: 'opus' } } }),
      [],
    );
  });

  it('says nothing for a config with no model saved at all', () => {
    assert.deepEqual(legacyProfileWarnings({}), []);
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
