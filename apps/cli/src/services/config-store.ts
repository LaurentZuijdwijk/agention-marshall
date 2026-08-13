import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import type { AgentProfile, McpServerConfig } from '@agentionai/marshall-engine';

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
// own model/provider without touching the user's global credentials.
//
// That file cannot supply a credential: `loadConfig` strips every `apiKey` out
// of the project layer and `projectSecretWarnings` reports it, because the file
// is meant to be committed and a key in it is a leak for everyone who clones
// the repo. Use the global config, or the provider's environment variable in a
// gitignored `.env` (see startup/workspace.ts, which loads those before
// anything resolves).

export interface SavedProfile {
  provider?: string;
  model?: string;
  host?: string;
  apiKey?: string;
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

/** Last-used connection details for one provider, kept across switches. */
export interface SavedProviderEntry {
  name?: string;
  provider: string;
  host?: string;
  apiKey?: string;
}

/** A remote MCP server as stored. `headers` can hold a bearer token, which is
 *  the other reason this file is written 0600 and lives outside the repo. */
export interface SavedMcpServer {
  name?: string;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

/**
 * The project file's MCP section — safe to commit.
 *
 * Deliberately *not* the `mcpServers` array. Two reasons: `deepMerge` replaces
 * arrays wholesale, so a project-local `mcpServers` would silently replace the
 * global list and force every secret to be repeated here to keep the other
 * servers working; and this file lands in git, where a bearer token must never
 * be. This section can only select from what the global config defines, or
 * declare a server that needs no credentials at all.
 */
export interface SavedProjectMcp {
  /** Turn on globally-defined servers that are `enabled: false` by default. */
  enable?: string[];
  /** Turn off servers this project should not see. Beats `enable`. */
  disable?: string[];
  /** Servers only this project uses. `headers` is stripped — see resolveMcpServers. */
  servers?: SavedMcpServer[];
}

export interface SavedConfig extends SavedProfile {
  models?: { deep?: SavedProfile; fast?: SavedProfile };
  /**
   * Versioned, non-secret runtime settings. Deliberately `unknown`: this is
   * untrusted file content, and `services/settings.ts` owns both the shape and
   * the validation. Nothing else should read into it.
   */
  settings?: unknown;
  /**
   * Pre-settings way of asking for the lean tool belt. Still read, so existing
   * config files keep working; `settings.mode` is where it lives now, and the
   * first write through `saveSettings` folds this key into it.
   */
  light?: boolean;
  providers?: SavedProviderEntry[];
  mcpServers?: SavedMcpServer[];
  mcp?: SavedProjectMcp;
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

export function readJsonConfig(path: string): SavedConfig {
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
 * Merge two provider-entry lists by provider name, project entries winning a
 * conflict.
 *
 * `deepMerge` alone would let a project pin one provider and, as a side
 * effect, wholesale-replace the *entire* `providers` array — silently hiding
 * every other provider's stored host and API key, including ones the project
 * never mentioned. `mcpServers` gets the same wholesale-replace treatment,
 * which is why it is resolved through `resolveMcpServers` instead of the
 * merged config; `providers` needs the same escape hatch since it is where
 * credentials live.
 */
function mergeProviders(
  global: SavedProviderEntry[],
  project: SavedProviderEntry[],
): SavedProviderEntry[] {
  const byProvider = new Map<string, SavedProviderEntry>();
  for (const entry of global) if (entry?.provider) byProvider.set(entry.provider, entry);
  // Field by field, not entry by entry: a project pinning one provider's *host*
  // should not also erase the key stored globally for that same provider. Since
  // the project layer cannot supply a key at all (see `stripProjectSecrets`),
  // whole-entry replacement could only ever delete credentials, never set them.
  for (const entry of project) {
    if (!entry?.provider) continue;
    byProvider.set(entry.provider, { ...byProvider.get(entry.provider), ...entry });
  }
  return [...byProvider.values()];
}

/**
 * Every place a credential could hide in a project file.
 *
 * The module comment has always said the project file must not hold an
 * `apiKey`; this is what makes that true rather than aspirational. A key in a
 * committed file is a leak for everyone who clones the repo, and "it worked, so
 * nobody noticed" is exactly how it stays there. Stripped rather than rejected,
 * so a file that is otherwise fine still pins its model.
 */
function stripProjectSecrets(project: SavedConfig): { config: SavedConfig; found: string[] } {
  const found: string[] = [];
  const scrub = <T extends SavedProfile>(profile: T | undefined, where: string): T | undefined => {
    if (!profile?.apiKey) return profile;
    found.push(where);
    const { apiKey: _dropped, ...rest } = profile;
    return rest as T;
  };

  const providers = project.providers?.map(entry =>
    scrub(entry, `providers[${entry?.provider ?? '?'}]`) as SavedProviderEntry);
  const models = project.models && {
    ...project.models,
    deep: scrub(project.models.deep, 'models.deep'),
    fast: scrub(project.models.fast, 'models.fast'),
  };

  const config = {
    ...scrub(project, 'apiKey'),
    ...(models ? { models } : {}),
    ...(providers ? { providers } : {}),
  };
  return { config, found };
}

/**
 * Read at startup. Never throws — a corrupt file behaves like no file.
 *
 * Loads the global config (creating it if this is the first run), then, if the
 * project has its own `.marshall/config.json`, deep-merges it on top — project
 * values win, except for credentials, which the project layer is not allowed to
 * supply at all. See the module comment.
 */
export function loadConfig(workspaceRoot: string): SavedConfig {
  ensureGlobalConfig();
  const global = readJsonConfig(globalConfigPath());
  const projectPath = configPath(workspaceRoot);
  if (!existsSync(projectPath)) return global;
  const { config: project } = stripProjectSecrets(readJsonConfig(projectPath));
  const merged = deepMerge(global, project);
  const providers = mergeProviders(global.providers ?? [], project.providers ?? []);
  return providers.length > 0 ? { ...merged, providers } : merged;
}

/**
 * Credentials found in the project file, which `loadConfig` has ignored.
 *
 * Reported rather than silently dropped: someone who put a key there is going
 * to wonder why authentication fails, and the answer ("that file gets
 * committed") is the whole point of the rule.
 */
export function projectSecretWarnings(workspaceRoot: string): string[] {
  const path = configPath(workspaceRoot);
  if (!existsSync(path)) return [];
  const { found } = stripProjectSecrets(readJsonConfig(path));
  if (found.length === 0) return [];
  return [`${path} contains an apiKey (${found.join(', ')}) — ignoring it, because that file `
    + 'is meant to be committed. Put the key in the global config via /model, or in a '
    + 'gitignored .env as the provider\'s environment variable.'];
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

/**
 * Configured MCP servers, with anything malformed dropped.
 *
 * This is untrusted file content that becomes network connections, so entries
 * without both a name and a url are discarded rather than passed on to fail
 * later at connect time with a less obvious message.
 */
export function savedMcpServers(config: SavedConfig): McpServerConfig[] {
  return (config.mcpServers ?? [])
    .filter((s): s is SavedMcpServer & { name: string; url: string } =>
      Boolean(s && typeof s.name === 'string' && typeof s.url === 'string'))
    .map(s => ({
      name: s.name,
      url: s.url,
      ...(s.headers ? { headers: s.headers } : {}),
      ...(s.enabled === false ? { enabled: false } : {}),
    }));
}

/**
 * The servers to actually connect to, from the two files.
 *
 * Layering, in one place so the rules are visible:
 *
 *   - The global config *defines* servers, credentials included. `enabled:
 *     false` means "configured, but off unless a project asks for it" — which
 *     is how a personal server stays out of every unrelated checkout.
 *   - The project config *selects*: `enable` opts into a default-off server,
 *     `disable` opts out of a default-on one. `disable` wins, because the safe
 *     direction to resolve a contradiction is fewer tools, not more.
 *   - A project may declare its own servers, but never their `headers`. That
 *     file is meant to be committed, and a bearer token in git is a leak for
 *     everyone who clones it. A no-auth local server still works.
 *
 * Pure, so the precedence is testable without touching a disk.
 */
export function resolveMcpServers(global: SavedConfig, project: SavedConfig): McpServerConfig[] {
  const section = project.mcp ?? {};
  const disabled = new Set(section.disable ?? []);
  const enabled = new Set(section.enable ?? []);

  const defined = savedMcpServers(global);
  // Stripped, not rejected: a project-declared server pointing at localhost is
  // a legitimate and useful thing, it just cannot carry a credential.
  const projectOwn = savedMcpServers({ mcpServers: section.servers })
    .map(({ headers: _dropped, ...server }) => server);

  const byName = new Map<string, McpServerConfig>();
  for (const server of [...defined, ...projectOwn]) byName.set(server.name, server);

  return [...byName.values()]
    .filter(server => !disabled.has(server.name))
    .filter(server => server.enabled !== false || enabled.has(server.name))
    .map(({ enabled: _on, ...server }) => server);
}

/**
 * Names the project selects that no global definition matches.
 *
 * `resolveMcpServers` ignores these, which is the right behaviour — a stale
 * name in a committed file must not break startup for everyone. But ignoring
 * them *silently* means a project that enables a server nobody has defined
 * looks identical to a project with no MCP at all, and the user is left staring
 * at "no MCP servers configured" having just written the opposite. So the fact
 * is reported separately rather than folded into the resolution.
 */
export function danglingMcpSelections(global: SavedConfig, project: SavedConfig): string[] {
  const section = project.mcp ?? {};
  const defined = new Set([
    ...savedMcpServers(global).map(s => s.name),
    ...savedMcpServers({ mcpServers: section.servers }).map(s => s.name),
  ]);
  return [...new Set([...(section.enable ?? []), ...(section.disable ?? [])])]
    .filter(name => !defined.has(name));
}

/** Read both files and report any selection that resolves to nothing. */
export function loadMcpWarnings(workspaceRoot: string): string[] {
  const global = readJsonConfig(globalConfigPath());
  const project = readJsonConfig(configPath(workspaceRoot));
  return danglingMcpSelections(global, project).map(name =>
    `"${name}" is selected in .marshall/config.json but no server by that name is defined ` +
    `in ${globalConfigPath()} — run /mcp add to define it.`);
}

/** Read both files and resolve. The App's entry point for MCP config. */
export function loadMcpServers(workspaceRoot: string): McpServerConfig[] {
  ensureGlobalConfig();
  const global = readJsonConfig(globalConfigPath());
  const project = readJsonConfig(configPath(workspaceRoot));
  return resolveMcpServers(global, project);
}

/**
 * Stored API keys, keyed by provider.
 *
 * The counterpart to `savedHosts`, and needed for the same reason: the wizard
 * has to know a key already exists for the provider being chosen, or it asks
 * for one the user has already given.
 */
export function savedKeys(config: SavedConfig): Record<string, string | undefined> {
  return Object.fromEntries(
    (config.providers ?? [])
      .filter(e => e?.provider && e.apiKey)
      .map(e => [e.provider, e.apiKey]),
  );
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
    ...(profile.name ? { name: profile.name } : {}),
    provider: profile.provider,
    model: profile.model,
    ...(profile.host !== undefined ? { host: profile.host } : {}),
    ...(profile.apiKey ? { apiKey: profile.apiKey } : {}),
    ...(profile.reasoningEffort !== undefined ? { reasoningEffort: profile.reasoningEffort } : {}),
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
    ...(profile.name ? { name: profile.name } : {}),
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
 *
 * `existing` is spread back in rather than dropped. This used to take only the
 * providers array, which meant choosing a model silently deleted every other
 * section of the file — `mcpServers`, `mcp` and `settings` all lived through
 * exactly one `/model` before disappearing.
 */
export function buildConfig(
  deep: AgentProfile,
  fast: AgentProfile | undefined,
  existing: SavedConfig = {},
): SavedConfig {
  let providers = upsertProvider(existing.providers ?? [], deep);
  if (fast) providers = upsertProvider(providers, fast);

  return {
    ...existing,
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

  let existing: SavedConfig = {};
  try {
    existing = JSON.parse(await readFile(path, 'utf8')) as SavedConfig;
  } catch { /* no file yet, or unreadable — start from empty */ }

  await writeFile(path, JSON.stringify(buildConfig(deep, fast, existing), null, 2), { mode: 0o600 });
}

/**
 * Persist the MCP server list to the global config, leaving everything else in
 * the file untouched.
 *
 * A read-modify-write rather than a rebuild via `buildConfig`: that function
 * describes the *model* config, and routing MCP through it would mean every
 * server change also rewrites the tiers. Same 0600 as the rest — these entries
 * carry bearer tokens.
 */
export async function saveMcpServers(servers: McpServerConfig[]): Promise<void> {
  const path = globalConfigPath();
  await mkdir(globalConfigDir(), { recursive: true });

  let existing: SavedConfig = {};
  try {
    existing = JSON.parse(await readFile(path, 'utf8')) as SavedConfig;
  } catch { /* no file yet, or unreadable — start from empty */ }

  const next: SavedConfig = { ...existing, mcpServers: servers };
  await writeFile(path, JSON.stringify(next, null, 2), { mode: 0o600 });
}

/**
 * Record a project's MCP selection in `.marshall/config.json`.
 *
 * Written to the *project*, unlike every other writer here, because that is the
 * point: this file says which servers this checkout uses, and it carries no
 * credentials, so it is safe to commit. Existing keys are preserved — a repo
 * may well pin its model here too.
 */
export async function saveProjectMcpSelection(
  workspaceRoot: string,
  update: (current: SavedProjectMcp) => SavedProjectMcp,
): Promise<void> {
  const path = configPath(workspaceRoot);
  await mkdir(dirname(path), { recursive: true });

  let existing: SavedConfig = {};
  try {
    existing = JSON.parse(await readFile(path, 'utf8')) as SavedConfig;
  } catch { /* no file yet, or unreadable — start from empty */ }

  const next: SavedConfig = { ...existing, mcp: update(existing.mcp ?? {}) };
  await writeFile(path, JSON.stringify(next, null, 2) + '\n');
}
