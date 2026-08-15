import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentProfile, McpServerConfig } from '@agentionai/marshall-engine';

// ── the on-disk shape ─────────────────────────────────────────────────────────
//
// One owner for the config shape. The reader (startup) and the writer (the
// setup wizard) used to describe this shape separately, in two files, which
// is how a saved llama.cpp host could survive a write from one side and be
// dropped by the other.
//
// This module is pure: it describes the shape, merges the two layers and
// answers questions about a config value it was handed. It does not write. One
// service owns every write and every cache of what is on disk — see
// services/config-service.ts. Before that split there were five independent
// read-modify-write functions across two files, each with its own idea of the
// file mode and whether the directory existed, and two of them could interleave
// and drop each other's changes.
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
  /** Named endpoint within a provider (for openai-compatible servers). */
  name?: string;
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

/**
 * Which stored endpoint is meant.
 *
 * A provider is not an identity on its own: `openai-compatible` can be three
 * different servers at once, told apart by `name`. Passed as a value rather
 * than as a `"provider:name"` string, because a string key invites each call
 * site to build and parse it in its own slightly different way — which is
 * exactly how a lookup ends up silently missing every named endpoint. The one
 * place that stringifies a ref is `providerKey`, and it exists for map keys and
 * equality, never as a parameter type.
 */
export interface ProviderRef {
  provider: string;
  name?: string;
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
   * first write through `applySettings` folds this key into it.
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
  for (const entry of global) if (entry?.provider) byProvider.set(providerKey(entry), entry);
  // Field by field, not entry by entry: a project pinning one provider's *host*
  // should not also erase the key stored globally for that same provider. Since
  // the project layer cannot supply a key at all (see `stripProjectSecrets`),
  // whole-entry replacement could only ever delete credentials, never set them.
  for (const entry of project) {
    if (!entry?.provider) continue;
    const key = providerKey(entry);
    byProvider.set(key, { ...byProvider.get(key), ...entry });
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

/**
 * A model saved before `withModelSelection` existed — the flat top-level
 * `provider`/`model` keys instead of `models.deep`.
 *
 * `savedDeepProfile` above already reads it fine, so this is not a startup
 * error. But a config in this shape still lives entirely in the global file,
 * applying to every workspace on the machine, rather than the model choice
 * being pinned to this one — the split only takes effect once the model is
 * saved again. Worth telling the user rather than leaving them to notice by
 * accident, in the same spirit as `settingsWarnings`.
 */
export function legacyProfileWarnings(config: SavedConfig): string[] {
  if (config.models?.deep) return [];
  if (!config.provider && !config.model) return [];
  return ['the saved model is in the older, pre-workspace format, shared by every project '
    + 'on this machine — run /model to save it again and pin it to this workspace.'];
}

/** One ref as a map key. Equality only — nothing parses this back apart. */
export function providerKey(ref: ProviderRef): string {
  return ref.name ? `${ref.provider}:${ref.name}` : ref.provider;
}

export function sameProvider(a: ProviderRef, b: ProviderRef): boolean {
  return providerKey(a) === providerKey(b);
}

/** The stored entry for exactly this endpoint, or undefined. */
export function findProvider(
  entries: SavedProviderEntry[] | undefined,
  ref: ProviderRef,
): SavedProviderEntry | undefined {
  return (entries ?? []).find(entry => entry?.provider && sameProvider(entry, ref));
}

/**
 * What the wizard should pre-fill for `ref`.
 *
 * The host falls back to the provider's unnamed entry, because a URL is a
 * suggestion the user sees and confirms on screen, and starting a second
 * endpoint from the first one's address saves retyping it.
 *
 * The key deliberately does not fall back. A different endpoint name is a
 * different server, and seeding it with a credential stored for another one
 * sends that key somewhere it was never issued for — the same rule
 * `toSafetyAgentConfig` applies to the judge, for the same reason. A new named
 * endpoint asks for its own key instead.
 */
export function providerCredentials(
  entries: SavedProviderEntry[] | undefined,
  ref: ProviderRef,
): { host?: string; apiKey?: string } {
  const exact = findProvider(entries, ref);
  const unnamed = ref.name ? findProvider(entries, { provider: ref.provider }) : undefined;
  return {
    host: exact?.host ?? unnamed?.host,
    apiKey: exact?.apiKey,
  };
}

/**
 * The key for a profile identified by provider and host rather than by name.
 *
 * The stored judge (`services/settings.ts`) is the case this exists for: it
 * records provider/model/host and never a name, so it cannot be looked up by
 * ref. Matching on host first is what lets a judge pointed at a named endpoint
 * find that endpoint's key, while still refusing to hand it a key belonging to
 * some other server on the same provider.
 */
export function providerKeyForHost(
  entries: SavedProviderEntry[] | undefined,
  provider: string,
  host?: string,
): string | undefined {
  const candidates = (entries ?? []).filter(entry => entry?.provider === provider && entry.apiKey);
  if (host !== undefined) {
    const byHost = candidates.find(entry => entry.host === host);
    if (byHost) return byHost.apiKey;
  }
  // No host to match on, or none matched: only the provider's own unnamed entry
  // is safe to fall back to. Picking one of several named endpoints would be a
  // guess, and the thing being guessed at is a credential.
  return candidates.find(entry => !entry.name)?.apiKey;
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

// ── transforms ────────────────────────────────────────────────────────────────
//
// Pure, and applied by `ConfigService.write` to whatever is currently on disk.
// Keeping them here rather than in the service is what makes the merge rules
// testable without a filesystem.

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
 * Drop exactly one endpoint, leaving every other one alone.
 *
 * Compared by ref, not by provider: removing the unnamed `openai-compatible`
 * entry must not take `openai-compatible:LM Studio` with it. Comparing the two
 * fields separately reads as though it does the same thing and does not, which
 * is how deleting one endpoint deleted every sibling that shared its provider.
 *
 * Pure — returns a new array.
 */
export function removeProvider(
  providers: SavedProviderEntry[],
  ref: ProviderRef,
): SavedProviderEntry[] {
  return providers.filter(entry => !sameProvider(entry, ref));
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
  const index = providers.findIndex(e => sameProvider(e, profile));
  if (index === -1) return [...providers, entry];
  const next = [...providers];
  next[index] = entry;
  return next;
}

/** Everything about a profile except its credential. What the project file
 *  is allowed to say about a model — see AGENTS.md. */
function stripCredential(profile: AgentProfile): SavedProfile {
  const { apiKey: _drop, ...rest } = strip(profile);
  return rest;
}

/**
 * Pin which model each tier uses, without its credential.
 *
 * Written to the *project* file, so the choice is local to this workspace
 * instead of following the user to every other repo on the machine —
 * `withProviderCredentials` is where the credential that makes it work
 * actually lives.
 *
 * `existing` is spread back in rather than dropped. This used to take only the
 * providers array, which meant choosing a model silently deleted every other
 * section of the file — `mcpServers`, `mcp` and `settings` all lived through
 * exactly one `/model` before disappearing.
 */
export function withModelSelection(
  existing: SavedConfig,
  deep: AgentProfile,
  fast: AgentProfile | undefined,
): SavedConfig {
  return {
    ...existing,
    models: { deep: stripCredential(deep), ...(fast ? { fast: stripCredential(fast) } : {}) },
  };
}

/**
 * Remember this endpoint's host and key for next time.
 *
 * Always the global file: a credential is exactly what the project file must
 * never hold — see AGENTS.md.
 */
export function withProviderCredentials(
  existing: SavedConfig,
  deep: AgentProfile,
  fast: AgentProfile | undefined,
): SavedConfig {
  let providers = upsertProvider(existing.providers ?? [], deep);
  if (fast) providers = upsertProvider(providers, fast);
  return { ...existing, providers };
}

/**
 * Set the MCP server list, leaving everything else in the file untouched.
 *
 * Not routed through `buildConfig`: that function describes the *model* config,
 * and going through it would mean every server change also rewrites the tiers.
 */
export function withMcpServers(config: SavedConfig, servers: McpServerConfig[]): SavedConfig {
  return { ...config, mcpServers: servers };
}

/** Set the project's MCP selection, preserving anything else the repo pins. */
export function withProjectMcp(
  config: SavedConfig,
  update: (current: SavedProjectMcp) => SavedProjectMcp,
): SavedConfig {
  return { ...config, mcp: update(config.mcp ?? {}) };
}
