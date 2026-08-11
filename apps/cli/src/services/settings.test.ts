import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  readSettings, resolveSettings, loadSettings, saveSettings, projectSettings,
  settingsWarnings, toSavedSafetyAgent, toSafetyAgentConfig, SETTINGS_VERSION,
} from './settings.js';
import { configPath, globalConfigPath } from './config-store.js';
import type { AgentProfile } from '@agentionai/marshall-engine';

function ws(): string { return mkdtempSync(join(tmpdir(), 'set-')); }
function write(root: string, contents: unknown): void {
  mkdirSync(join(root, '.marshall'), { recursive: true });
  writeFileSync(configPath(root), JSON.stringify(contents));
}
function writeGlobal(contents: unknown): void {
  mkdirSync(dirname(globalConfigPath()), { recursive: true });
  writeFileSync(globalConfigPath(), JSON.stringify(contents));
}
function readProjectFile(root: string): any {
  return JSON.parse(readFileSync(configPath(root), 'utf8'));
}

const originalXdg = process.env.XDG_CONFIG_HOME;
beforeEach(() => {
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'xdg-'));
});
afterEach(() => {
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
});

const JUDGE = { provider: 'openrouter', model: 'kwaipilot/kat-coder-air-v2.5' };

describe('readSettings', () => {
  it('pins nothing when there is nothing to pin', () => {
    assert.deepEqual(readSettings({}), { version: SETTINGS_VERSION });
  });

  it('reads a current-version envelope', () => {
    assert.deepEqual(readSettings({ settings: { version: 1, runtime: 'light', safetyLevel: 2 } }), {
      version: 1, runtime: 'light', safetyLevel: 2,
    });
  });

  it('still honours the pre-settings top-level light flag', () => {
    assert.deepEqual(readSettings({ light: true }), { version: 1, runtime: 'light' });
  });

  it('lets an explicit runtime beat the legacy flag, so a file mid-migration is unambiguous', () => {
    assert.deepEqual(readSettings({ light: true, settings: { version: 1, runtime: 'default' } }), {
      version: 1, runtime: 'default',
    });
  });

  it('ignores an envelope from a version it does not understand', () => {
    // Half-reading a future shape is worse than ignoring it: the keys this
    // build recognises may not mean the same thing there.
    assert.deepEqual(readSettings({ settings: { version: 99, runtime: 'light' } }), { version: 1 });
  });

  it('drops a runtime that is not one of the three', () => {
    assert.deepEqual(readSettings({ settings: { version: 1, runtime: 'turbo' } }), { version: 1 });
  });

  it('drops a safety level outside 2 and 3, yolo included', () => {
    // Level 1 must never come back from a file — see PersistedSafetyLevel.
    assert.equal(readSettings({ settings: { version: 1, safetyLevel: 1 } }).safetyLevel, undefined);
    assert.equal(readSettings({ settings: { version: 1, safetyLevel: 9 } }).safetyLevel, undefined);
  });

  it('drops a judge whose provider is not a real one', () => {
    const out = readSettings({ settings: { version: 1, safetyAgent: { provider: 'acme', model: 'x' } } });
    assert.equal(out.safetyAgent, undefined);
  });

  it('drops a judge with no model', () => {
    const out = readSettings({ settings: { version: 1, safetyAgent: { provider: 'openrouter', model: '  ' } } });
    assert.equal(out.safetyAgent, undefined);
  });

  it('keeps kind and maxOutputTokens, which is what makes a guard model a guard model', () => {
    const out = readSettings({ settings: { version: 1, safetyAgent: {
      ...JUDGE, host: 'https://h', kind: 'nvidia-content-safety', maxOutputTokens: 1500,
    } } });
    assert.deepEqual(out.safetyAgent, {
      provider: 'openrouter', model: 'kwaipilot/kat-coder-air-v2.5',
      host: 'https://h', kind: 'nvidia-content-safety', maxOutputTokens: 1500,
    });
  });

  it('downgrades level 3 to 2 when the judge did not survive validation', () => {
    // The safe direction. Level 3 with no judge reviews nothing, and "reviews
    // nothing" must not resolve to "approves everything".
    const out = readSettings({ settings: { version: 1, safetyLevel: 3, safetyAgent: { provider: 'acme' } } });
    assert.equal(out.safetyLevel, 2);
    assert.equal(out.safetyAgent, undefined);
  });
});

describe('settingsWarnings', () => {
  it('says nothing about a clean config', () => {
    assert.deepEqual(settingsWarnings({ settings: { version: 1, runtime: 'light' } }), []);
  });

  it('explains an unreadable version rather than silently ignoring the file', () => {
    const [warning] = settingsWarnings({ settings: { version: 99 } });
    assert.match(warning, /version 99/);
  });

  it('explains a level-3 gate that lost its judge', () => {
    const warnings = settingsWarnings({ settings: { version: 1, safetyLevel: 3 } });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /level 2/);
  });

  it('explains a rejected judge', () => {
    const warnings = settingsWarnings({ settings: { version: 1, safetyAgent: { provider: 'acme' } } });
    assert.match(warnings[0], /provider and a model/);
  });

  it('reports both the rejected judge and the level it cost you', () => {
    // Two separate facts. Hearing only about the judge leaves the user assuming
    // the gate they configured is still the gate they got.
    const warnings = settingsWarnings({
      settings: { version: 1, safetyLevel: 3, safetyAgent: { provider: 'acme' } },
    });
    assert.equal(warnings.length, 2);
    assert.match(warnings.join('\n'), /provider and a model/);
    assert.match(warnings.join('\n'), /level 2/);
  });
});

describe('resolveSettings', () => {
  it('defaults to the full belt and the human gate', () => {
    assert.deepEqual(resolveSettings({ version: 1 }), { runtime: 'default', safetyLevel: 2 });
  });

  it('--light turns the lean belt on', () => {
    assert.equal(resolveSettings({ version: 1 }, { light: true }).runtime, 'light');
  });

  it('a pinned light runtime applies without any flag', () => {
    assert.equal(resolveSettings({ version: 1, runtime: 'light' }).runtime, 'light');
  });

  it('--light cannot turn a pinned default off, matching --github', () => {
    assert.equal(resolveSettings({ version: 1, runtime: 'default' }, { light: false }).runtime, 'default');
    assert.equal(resolveSettings({ version: 1, runtime: 'default' }, { light: true }).runtime, 'light');
  });
});

describe('loadSettings', () => {
  it('merges both files, project winning', () => {
    writeGlobal({ settings: { version: 1, runtime: 'light', safetyLevel: 3, safetyAgent: JUDGE } });
    const root = ws();
    write(root, { settings: { version: 1, runtime: 'default' } });

    const settings = loadSettings(root);
    assert.equal(settings.runtime, 'default', 'the project pin wins');
    assert.equal(settings.safetyLevel, 3, 'and the global one survives where the project is silent');
    assert.equal(settings.safetyAgent?.model, JUDGE.model);
  });
});

describe('saveSettings', () => {
  it('writes only what was asked for, not every resolved default', () => {
    const root = ws();
    return saveSettings(root, current => ({ ...current, runtime: 'light' })).then(() => {
      // Pinning a safety level here would freeze a default into a committed
      // file and quietly stop tracking any later change to it.
      assert.deepEqual(readProjectFile(root).settings, { version: 1, runtime: 'light' });
    });
  });

  it('preserves the rest of the project file', async () => {
    const root = ws();
    write(root, { provider: 'llamacpp', mcp: { enable: ['local'] } });
    await saveSettings(root, current => ({ ...current, runtime: 'light' }));

    assert.deepEqual(readProjectFile(root), {
      provider: 'llamacpp',
      mcp: { enable: ['local'] },
      settings: { version: 1, runtime: 'light' },
    });
  });

  it('folds the legacy light flag in and deletes it, so the file has one answer', async () => {
    const root = ws();
    write(root, { light: true });
    await saveSettings(root, current => ({ ...current, runtime: 'default' }));

    const file = readProjectFile(root);
    assert.equal(file.light, undefined, 'an older build must not read the opposite from the same file');
    assert.deepEqual(file.settings, { version: 1, runtime: 'default' });
  });

  it('removes a pin when the update returns undefined', async () => {
    const root = ws();
    write(root, { settings: { version: 1, safetyLevel: 3, safetyAgent: JUDGE } });
    await saveSettings(root, current => ({ ...current, safetyLevel: 2, safetyAgent: undefined }));

    // Otherwise a judge could never be dropped without hand-editing the file.
    assert.deepEqual(readProjectFile(root).settings, { version: 1, safetyLevel: 2 });
  });

  it('writes globally when asked, keeping 0600 because that file holds keys', async () => {
    const root = ws();
    writeGlobal({ providers: [{ provider: 'openrouter', apiKey: 'k' }] });
    await saveSettings(root, current => ({ ...current, runtime: 'light' }), 'global');

    const global = JSON.parse(readFileSync(globalConfigPath(), 'utf8'));
    assert.deepEqual(global.settings, { version: 1, runtime: 'light' });
    assert.deepEqual(global.providers, [{ provider: 'openrouter', apiKey: 'k' }]);
    assert.equal(statSync(globalConfigPath()).mode & 0o777, 0o600);
    assert.equal(projectSettings(root).runtime, undefined, 'and leaves the project file alone');
  });

  it('starts from empty rather than throwing on an unreadable file', async () => {
    const root = ws();
    mkdirSync(join(root, '.marshall'), { recursive: true });
    writeFileSync(configPath(root), '{ not json');
    await saveSettings(root, current => ({ ...current, runtime: 'light' }));
    assert.deepEqual(readProjectFile(root).settings, { version: 1, runtime: 'light' });
  });
});

describe('judge conversion', () => {
  const main: AgentProfile = { provider: 'openrouter', model: 'deep', apiKey: 'main-key' };

  it('never writes a credential to disk', () => {
    const saved = toSavedSafetyAgent({ profile: { provider: 'openrouter', model: 'j', apiKey: 'secret' } });
    assert.equal((saved as Record<string, unknown>).apiKey, undefined);
    assert.deepEqual(saved, { provider: 'openrouter', model: 'j' });
  });

  it('resolves the model, so the file records what actually reviewed the calls', () => {
    assert.equal(toSavedSafetyAgent({ profile: { provider: 'claude' } }).model, 'claude-sonnet-4-6');
  });

  it('round-trips kind and maxOutputTokens', () => {
    const saved = toSavedSafetyAgent({
      profile: { provider: 'openrouter', model: 'j' }, kind: 'nvidia-content-safety', maxOutputTokens: 1500,
    });
    assert.equal(saved.kind, 'nvidia-content-safety');
    assert.equal(saved.maxOutputTokens, 1500);
  });

  it('inherits the main key when the judge shares the provider', () => {
    const agent = toSafetyAgentConfig({ provider: 'openrouter', model: 'j' }, { mainProfile: main });
    assert.equal(agent.profile.apiKey, 'main-key');
  });

  it('takes a different provider’s key from the global config instead', () => {
    const agent = toSafetyAgentConfig({ provider: 'claude', model: 'j' }, {
      mainProfile: main, savedKeys: { claude: 'claude-key' },
    });
    assert.equal(agent.profile.apiKey, 'claude-key');
  });

  it('does not hand the main key to a judge pointed at another host', () => {
    // A different host is a different service. A committed config naming one
    // must not turn into an API key sent wherever it says.
    const agent = toSafetyAgentConfig(
      { provider: 'openrouter', model: 'j', host: 'https://elsewhere.example' },
      { mainProfile: main },
    );
    assert.equal(agent.profile.apiKey, undefined);
  });

  it('leaves the key unset when nothing has one, so the engine can fall back to the env var', () => {
    const agent = toSafetyAgentConfig({ provider: 'claude', model: 'j' }, { mainProfile: main });
    assert.equal(agent.profile.apiKey, undefined);
  });
});
