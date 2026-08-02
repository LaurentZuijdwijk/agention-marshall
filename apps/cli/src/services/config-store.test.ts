import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildConfig, upsertProvider, loadConfig, savedDeepProfile, savedProviders, savedHosts,
  saveConfig, configPath,
} from './config-store.js';
import type { SavedProviderEntry } from './config-store.js';
import type { AgentProfile } from '@agentionai/marshall-engine';

const LOCAL: AgentProfile = { provider: 'llamacpp', model: 'qwen', host: 'http://192.168.1.248:8080' };
const ROUTER: AgentProfile = { provider: 'openrouter', model: 'deepseek/v4', apiKey: 'or-key' };

function ws(): string { return mkdtempSync(join(tmpdir(), 'cfg-')); }
function write(root: string, contents: unknown): void {
  mkdirSync(join(root, '.marshall'), { recursive: true });
  writeFileSync(configPath(root), JSON.stringify(contents));
}

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
    const out = buildConfig(ROUTER, undefined, [{ provider: 'ollama', host: 'http://localhost:11434' }]);
    assert.equal(out.providers?.find(e => e.provider === 'ollama')?.host, 'http://localhost:11434');
  });
});

describe('loadConfig', () => {
  it('returns an empty config when there is no file', () => {
    assert.deepEqual(loadConfig(ws()), {});
  });

  it('survives a corrupt file rather than crashing startup', () => {
    const root = ws();
    mkdirSync(join(root, '.marshall'), { recursive: true });
    writeFileSync(configPath(root), '{ not json');
    assert.deepEqual(loadConfig(root), {});
  });

  it('survives a file that parses to a non-object', () => {
    const root = ws();
    write(root, 'just a string');
    assert.deepEqual(loadConfig(root), {});
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
  it('round-trips through the reader', async () => {
    const root = ws();
    await saveConfig(root, ROUTER, LOCAL);
    const back = loadConfig(root);
    assert.equal(savedDeepProfile(back).model, 'deepseek/v4');
    assert.deepEqual(savedHosts(back), { llamacpp: 'http://192.168.1.248:8080' });
  });

  it('preserves a provider entry written by an earlier session', async () => {
    const root = ws();
    write(root, { providers: [{ provider: 'ollama', host: 'http://localhost:11434' }] });
    await saveConfig(root, ROUTER, undefined);
    assert.equal(savedHosts(loadConfig(root)).ollama, 'http://localhost:11434');
  });

  it('switching provider keeps the previous provider’s host', async () => {
    const root = ws();
    await saveConfig(root, LOCAL, undefined);          // using llama.cpp
    await saveConfig(root, ROUTER, undefined);         // switch to OpenRouter
    const hosts = savedHosts(loadConfig(root));
    assert.equal(hosts.llamacpp, 'http://192.168.1.248:8080', 'the llama.cpp host must survive the switch');
  });

  it('writes 0600, since the file can hold an API key', async () => {
    const root = ws();
    await saveConfig(root, ROUTER, undefined);
    assert.equal(statSync(configPath(root)).mode & 0o777, 0o600);
  });

  it('recovers from a corrupt existing file instead of throwing', async () => {
    const root = ws();
    mkdirSync(join(root, '.marshall'), { recursive: true });
    writeFileSync(configPath(root), 'not json at all');
    await saveConfig(root, ROUTER, undefined);
    assert.equal(JSON.parse(readFileSync(configPath(root), 'utf8')).provider, 'openrouter');
  });
});
