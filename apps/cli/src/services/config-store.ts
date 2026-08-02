import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentProfile } from '@agentionai/marshall-engine';

// ── the on-disk shape ─────────────────────────────────────────────────────────
//
// One owner for `.marshall/config.json`. The reader (startup) and the writer
// (the setup wizard) used to describe this shape separately, in two files, which
// is how a saved llama.cpp host could survive a write from one side and be
// dropped by the other.
//
// Fields are optional and loosely typed on purpose: this is untrusted file
// content, and an older or hand-edited file must not crash startup.

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

export function configPath(workspaceRoot: string): string {
  return join(workspaceRoot, '.marshall', 'config.json');
}

/** Read at startup. Never throws — a corrupt file behaves like no file. */
export function loadConfig(workspaceRoot: string): SavedConfig {
  const path = configPath(workspaceRoot);
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed as SavedConfig : {};
  } catch {
    return {};
  }
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
 * Persist both tiers, preserving the entries of providers not involved.
 *
 * Written 0600 because it can hold an API key. Rejections are the caller's to
 * handle; the App treats a failed save as non-fatal.
 */
export async function saveConfig(
  workspaceRoot: string,
  deep: AgentProfile,
  fast: AgentProfile | undefined,
): Promise<void> {
  const path = configPath(workspaceRoot);
  await mkdir(join(workspaceRoot, '.marshall'), { recursive: true });

  let existing: SavedProviderEntry[] = [];
  try {
    existing = (JSON.parse(await readFile(path, 'utf8')) as SavedConfig).providers ?? [];
  } catch { /* no file yet, or unreadable — start from empty */ }

  await writeFile(path, JSON.stringify(buildConfig(deep, fast, existing), null, 2), { mode: 0o600 });
}
