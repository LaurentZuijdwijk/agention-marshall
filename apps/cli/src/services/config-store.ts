import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentProfile } from '@agentionai/marshall-engine';

// ── the on-disk shape ─────────────────────────────────────────────────────────
//
// One owner for the config shape. The reader (startup) and the writer (the
// setup wizard) used to describe this shape separately, in two files, which
// is how a saved llama.cpp host could survive a write from one side and be
// dropped by the other.
//
// Fields are optional and loosely typed on purpose: this is untrusted file
// content, and an older or hand-edited file must not crash startup.
//
// Credentials and provider/model settings live in a *global* config, since a
// project checkout is the wrong place to keep an API key: `~/.config/marshall/
// config.json`, or `$XDG_CONFIG_HOME/marshall/config.json` when that's set.
// It's created empty on first run.
//
// A project-local `.marshall/config.json`, if the repo has one, is deep-merged
// on top of the global config — project values win. This lets a repo pin its
// own model/provider without touching the user's global credentials. If that
// file is checked in, it should NOT hold a bare `apiKey` — reference an env
// var (or omit `apiKey` entirely and rely on the provider's default env var)
// instead, or a future contributor's secret ends up committed for everyone.

export interface SavedProfile {
  provider?: string;
  model?: string;
  host?: string;
  apiKey?: string;
}

/** Last-used connection details for one provider, kept across switches. */
export interface SavedProviderEntry {
  provider: string;
  host?: string;
  apiKey?: string;
}

export interface SavedConfig extends SavedProfile {
  models?: { deep?: SavedProfile; fast?: SavedProfile };
  providers?: SavedProviderEntry[];
}

/** Directory holding the global config, honouring `$XDG_CONFIG_HOME`. */
function globalConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() ? xdg : join(homedir(), '.config');
  return join(base, 'marshall');
}

export function globalConfigPath(): string {
  return join(globalConfigDir(), 'config.json');
}

/** The optional project-local override, `.marshall/config.json` in the workspace root. */
export function configPath(workspaceRoot: string): string {
  return join(workspaceRoot, '.marshall', 'config.json');
}

function readJsonConfig(path: string): SavedConfig {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed as SavedConfig : {};
  } catch {
    return {};
  }
}

/** First run: create an empty global config so there's always something to edit or point at. */
function ensureGlobalConfig(): void {
  const path = globalConfigPath();
  if (existsSync(path)) return;
  mkdirSync(globalConfigDir(), { recursive: true });
  writeFileSync(path, JSON.stringify({}, null, 2) + '\n', { mode: 0o600 });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Recursively merges `override` onto `base`. Arrays and primitives are replaced wholesale — only
 *  plain objects (e.g. `models`) merge key by key, so a project's `models.deep` doesn't require
 *  repeating `models.fast` just to keep it. */
function deepMerge<T>(base: T, override: T): T {
  if (isPlainObject(base) && isPlainObject(override)) {
    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(override)) {
      merged[key] = key in merged ? deepMerge(merged[key], value) : value;
    }
    return merged as T;
  }
  return override ?? base;
}

/**
 * Read at startup. Never throws — a corrupt file behaves like no file.
 *
 * Loads the global config (creating it if this is the first run), then, if the
 * project has its own `.marshall/config.json`, deep-merges it on top — project
 * values win. See the module comment for why credentials belong in the global
 * file, not the project-local one.
 */
export function loadConfig(workspaceRoot: string): SavedConfig {
  ensureGlobalConfig();
  const global = readJsonConfig(globalConfigPath());
  const projectPath = configPath(workspaceRoot);
  if (!existsSync(projectPath)) return global;
  return deepMerge(global, readJsonConfig(projectPath));
}

/**
 * The deep tier as stored. Falls back to the flat top-level keys, which are the
 * pre-tier format — existing workspaces keep working untouched.
 */
export function savedDeepProfile(config: SavedConfig): SavedProfile {
  return config.models?.deep ?? config;
}

/** Per-provider entries keyed by provider, for seeding the setup wizard. */
export function savedProviders(config: SavedConfig): Record<string, SavedProviderEntry> {
  const byProvider: Record<string, SavedProviderEntry> = {};
  for (const entry of config.providers ?? []) {
    if (entry?.provider) byProvider[entry.provider] = entry;
  }
  return byProvider;
}

/** Just the hosts, which is all the App needs to re-seed a provider switch. */
export function savedHosts(config: SavedConfig): Record<string, string | undefined> {
  return Object.fromEntries(
    (config.providers ?? [])
      .filter(e => e?.provider && e.host !== undefined)
      .map(e => [e.provider, e.host]),
  );
}

// ── writing ───────────────────────────────────────────────────────────────────

/** Drop undefined/empty fields so they never land in the file as nulls. */
function strip(profile: AgentProfile): SavedProfile {
  return {
    provider: profile.provider,
    model: profile.model,
    ...(profile.host !== undefined ? { host: profile.host } : {}),
    ...(profile.apiKey ? { apiKey: profile.apiKey } : {}),
  };
}

/**
 * Update-or-insert one provider's entry, leaving every other provider alone.
 *
 * This is the bit that makes a provider switch non-destructive: moving from
 * llama.cpp to OpenRouter must not discard the llama.cpp host, or the next
 * switch back prompts for it again.
 *
 * Pure — returns a new array.
 */
export function upsertProvider(
  providers: SavedProviderEntry[],
  profile: AgentProfile,
): SavedProviderEntry[] {
  const entry: SavedProviderEntry = {
    provider: profile.provider,
    ...(profile.host !== undefined ? { host: profile.host } : {}),
    ...(profile.apiKey ? { apiKey: profile.apiKey } : {}),
  };
  const index = providers.findIndex(e => e.provider === profile.provider);
  if (index === -1) return [...providers, entry];
  const next = [...providers];
  next[index] = entry;
  return next;
}

/**
 * The full file contents for a given pair of tiers.
 *
 * Pure, so the merge rules are testable without touching a disk. The flat
 * top-level keys mirror the deep tier so an older build still finds a model.
 */
export function buildConfig(
  deep: AgentProfile,
  fast: AgentProfile | undefined,
  existingProviders: SavedProviderEntry[] = [],
): SavedConfig {
  let providers = upsertProvider(existingProviders, deep);
  if (fast) providers = upsertProvider(providers, fast);

  return {
    ...strip(deep),
    models: { deep: strip(deep), ...(fast ? { fast: strip(fast) } : {}) },
    providers,
  };
}

/**
 * Persist both tiers to the global config, preserving the entries of providers
 * not involved.
 *
 * Written 0600 because it can hold an API key. Always the global file, never
 * the project-local override — the setup wizard is saving credentials, and
 * those don't belong in a repo. Rejections are the caller's to handle; the App
 * treats a failed save as non-fatal.
 */
export async function saveConfig(
  deep: AgentProfile,
  fast: AgentProfile | undefined,
): Promise<void> {
  const path = globalConfigPath();
  await mkdir(globalConfigDir(), { recursive: true });

  let existing: SavedProviderEntry[] = [];
  try {
    existing = (JSON.parse(await readFile(path, 'utf8')) as SavedConfig).providers ?? [];
  } catch { /* no file yet, or unreadable — start from empty */ }

  await writeFile(path, JSON.stringify(buildConfig(deep, fast, existing), null, 2), { mode: 0o600 });
}
