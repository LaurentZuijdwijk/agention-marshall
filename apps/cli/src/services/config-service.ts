// ── the config service ────────────────────────────────────────────────────────
//
// Every read of configuration, and every write to it, goes through one object.
//
// Before this there were five independent writers — `saveConfig`,
// `saveMcpServers`, `saveProjectMcpSelection`, `removeSavedProvider` and
// `saveSettings` — each doing its own `mkdir` → read → parse → spread → write,
// each with its own idea of the file mode, and each racing the others through a
// read-modify-write cycle that could drop the change made next to it. Alongside
// them the App kept its own copies of the same data in React state and in
// props, so a write that landed on disk could leave the screen showing the
// value from before it, and a removal could leave the removed thing on screen
// to be removed again.
//
// Two rules make that class of bug unrepresentable:
//
//   1. Disk is the source of truth. Nothing here holds a mutable model of the
//      config. The snapshot is a memo of what was last read, thrown away by
//      every write, so the next reader re-reads the file. A write reads the
//      file it is about to write *inside* the queued task, never from the memo.
//   2. One write path. `write()` is the only thing in the app that opens a
//      config file for writing. Everything public is a transform handed to it.
//
// Writes are serialised through a promise chain, so two settings changed in the
// same tick cannot each read the file before the other writes it.

import { writeFile, mkdir, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AgentProfile, McpServerConfig } from '@agentionai/marshall-engine';
import {
  configPath, findProvider, globalConfigPath, legacyProfileWarnings, loadConfig, loadMcpWarnings,
  projectSecretWarnings, providerCredentials, providerKeyForHost, readJsonConfig, removeProvider,
  resolveMcpServers, withAgents, withMcpServers, withModelSelection, withProjectMcp, withProviderCredentials,
} from './config-store.js';
import type { ProviderRef, SavedAgentEntry, SavedConfig, SavedProviderEntry } from './config-store.js';
import {
  applySettings, readSettings, resolveSettings, settingsWarnings,
} from './settings.js';
import type { SettingsFile, SettingsFlags, SettingsScope, Settings } from './settings.js';

/**
 * Everything readable about the current configuration, as one immutable value.
 *
 * Handed to components whole rather than unpacked into five props. The identity
 * changes exactly when the files change, which is what lets a subscriber
 * re-render on a write and nothing else.
 */
export interface ConfigSnapshot {
  /** The merged view: global config with the project's overrides on top. */
  config: SavedConfig;
  /** Every stored endpoint, in file order. Credentials included — this never leaves the process. */
  providers: SavedProviderEntry[];
  /** The servers this workspace should connect to, after the project's selection. */
  mcpServers: McpServerConfig[];
  /** Named agents this workspace has defined, project-scoped. */
  agents: SavedAgentEntry[];
  /** Resolved settings, CLI flags applied. What the session runs with. */
  settings: Settings;
  /** What this repo alone pins, ignoring the global config. */
  projectSettings: SettingsFile;
  /** Project MCP selections that resolve to nothing. */
  mcpWarnings: string[];
  /** Everything worth telling the user at startup, MCP included. */
  warnings: string[];
}

export class ConfigService {
  private memo: ConfigSnapshot | null = null;
  private listeners = new Set<() => void>();
  /** Serialises writes. Never rejects — see `write`. */
  private queue: Promise<void> = Promise.resolve();

  /**
   * @param onError Called with a human-readable message when a write fails.
   *   A write that cannot be persisted used to be swallowed by `.catch(() => {})`
   *   at each call site, so a read-only config directory looked exactly like a
   *   setting that saved fine.
   */
  constructor(
    private readonly workspaceRoot: string,
    private readonly flags: SettingsFlags = {},
    private onError: (message: string) => void = () => {},
  ) {}

  /**
   * Send write failures somewhere else from now on.
   *
   * The service outlives the UI: it is built at startup, before there is a
   * transcript to report into, and the App redirects errors to one once it has
   * mounted.
   */
  reportErrorsTo(sink: (message: string) => void): void {
    this.onError = sink;
  }

  /**
   * The current configuration, re-read from disk if a write has happened since
   * the last call.
   *
   * Bound and memoised because `useSyncExternalStore` requires a getter that
   * returns a stable value between changes; returning a fresh object per call
   * would make React loop.
   */
  snapshot = (): ConfigSnapshot => {
    if (this.memo) return this.memo;

    // The merged view for everything that reads a *value*, and the two raw
    // files for MCP, whose layering rules are about which file said what.
    const config = loadConfig(this.workspaceRoot);
    const global = readJsonConfig(globalConfigPath());
    const project = readJsonConfig(configPath(this.workspaceRoot));
    const mcpWarnings = loadMcpWarnings(this.workspaceRoot);

    this.memo = {
      config,
      providers: config.providers ?? [],
      mcpServers: resolveMcpServers(global, project),
      agents: config.agents ?? [],
      settings: resolveSettings(readSettings(config), this.flags),
      projectSettings: readSettings(project),
      mcpWarnings,
      warnings: [
        ...mcpWarnings,
        ...settingsWarnings(config),
        ...projectSecretWarnings(this.workspaceRoot),
        ...legacyProfileWarnings(config),
      ],
    };
    return this.memo;
  };

  /** Bound, so it can be handed straight to `useSyncExternalStore`. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  // ── reading ─────────────────────────────────────────────────────────────────

  /** What the wizard should pre-fill for one endpoint. See `providerCredentials`. */
  credentialsFor = (ref: ProviderRef): { host?: string; apiKey?: string } =>
    providerCredentials(this.snapshot().providers, ref);

  /** The stored key for a provider at a host — how the judge authenticates. */
  keyFor = (provider: string, host?: string): string | undefined =>
    providerKeyForHost(this.snapshot().providers, provider, host);

  // ── writing ─────────────────────────────────────────────────────────────────

  /**
   * Persist both model tiers: the credential in the global file, which model/
   * provider is selected in the project file.
   *
   * Two writes, not one — a credential is the same wherever marshall runs, so
   * it belongs in the file every workspace shares, but which model this
   * workspace uses is a per-project choice and must not follow the user to
   * every other repo on the machine. See AGENTS.md.
   *
   * Like every mutation here, resolves `true` only once both writes reached
   * disk — a caller that announces "saved" on a promise that merely settled
   * will contradict the error this reported a line earlier.
   */
  saveProfiles(deep: AgentProfile, fast: AgentProfile | undefined): Promise<boolean> {
    return this.writeMany([
      { scope: 'global', what: 'provider credentials', transform: config => withProviderCredentials(config, deep, fast) },
      { scope: 'project', what: 'model selection', transform: config => withModelSelection(config, deep, fast) },
    ]);
  }

  /**
   * Forget one endpoint's stored host and key, wherever it is defined.
   *
   * A provider entry can live in the global file, the project file, or both —
   * `mergeProviders` combines the two field by field, and the merged result is
   * what the settings menu shows. Removal has to check both rather than assume
   * global, or an entry the project file contributes (a shared host with no
   * key, committed for the whole team) survives the write untouched and
   * reappears on the very next merge, while the UI has already said it was
   * removed.
   *
   * Each file is only opened if the entry actually lives there: writing to the
   * project scope unconditionally would create `.marshall/config.json` out of
   * nothing for an entry that only ever lived in the global one.
   */
  removeProvider(ref: ProviderRef): Promise<boolean> {
    const inGlobal = findProvider(readJsonConfig(globalConfigPath()).providers, ref) !== undefined;
    const inProject = findProvider(readJsonConfig(configPath(this.workspaceRoot)).providers, ref) !== undefined;
    if (!inGlobal && !inProject) return Promise.resolve(false);

    const drop = (config: SavedConfig): SavedConfig => ({
      ...config,
      providers: removeProvider(config.providers ?? [], ref),
    });
    return Promise.all([
      ...(inGlobal ? [this.write('global', 'provider list', drop)] : []),
      ...(inProject ? [this.write('project', 'provider list', drop)] : []),
    ]).then(results => results.every(Boolean));
  }

  /**
   * Persist the MCP server definitions.
   *
   * Always the global file: these entries carry bearer tokens, and that file is
   * the one that is `0600` and outside the repo.
   */
  saveMcpServers(servers: McpServerConfig[]): Promise<boolean> {
    return this.write('global', 'MCP servers', config => withMcpServers(config, servers));
  }

  /**
   * Opt this checkout into a globally-defined server that is off by default.
   *
   * The project file gets the *selection* only; the definition, with its
   * headers, stays global. That split is the rule in AGENTS.md: a committed
   * file may say which servers a repo uses, never what the credential is.
   */
  enableProjectMcpServer(name: string): Promise<boolean> {
    return this.write('project', 'MCP selection', config =>
      withProjectMcp(config, current => ({
        ...current,
        enable: [...new Set([...(current.enable ?? []), name])],
      })));
  }

  /**
   * Persist the named-agent list.
   *
   * Always the project file, and always the whole array: a named agent is a
   * model/provider choice, not a credential — the same split as
   * `withModelSelection`. The caller (the `/agent` command handler) computes
   * the new array from `snapshot().agents`.
   */
  saveAgents(agents: SavedAgentEntry[]): Promise<boolean> {
    return this.write('project', 'agents', config => withAgents(config, agents));
  }

  /** Pin a runtime setting in one of the two files. */
  updateSettings(
    update: (current: SettingsFile) => SettingsFile,
    scope: SettingsScope = 'project',
  ): Promise<boolean> {
    return this.write(scope, 'settings', config => applySettings(config, update));
  }

  // ── the only writer ─────────────────────────────────────────────────────────

  /** Read one target file, transform it, write it back. No queueing, no
   *  invalidate/notify — `write` and `writeMany` below wrap this with those,
   *  since a multi-file save needs them to happen once for every file rather
   *  than once per file. */
  private async performWrite(
    scope: SettingsScope,
    transform: (config: SavedConfig) => SavedConfig,
  ): Promise<void> {
    const path = scope === 'global' ? globalConfigPath() : configPath(this.workspaceRoot);
    await mkdir(dirname(path), { recursive: true });
    // From disk, not from `this.memo`: the memo is a rendering convenience and
    // may predate another writer's change.
    const next = transform(readJsonConfig(path));
    await writeFile(path, JSON.stringify(next, null, 2) + '\n',
      scope === 'global' ? { mode: 0o600 } : {});
    // `mode` on writeFile only applies when the file is created, and the global
    // config normally already exists. Tighten it explicitly, so a file that was
    // once created loosely does not stay that way while holding an API key.
    if (scope === 'global') await chmod(path, 0o600);
  }

  /**
   * Read the target file, transform it, write it back, invalidate, notify.
   *
   * Queued: the transform runs against what is on disk at the moment it is its
   * turn, not against what was there when the caller asked. Two settings
   * changed in one tick therefore compose instead of the second overwriting the
   * first with a stale base.
   *
   * Never rejects: failures go to `onError` and the promise resolves `false`,
   * so no call site can produce an unhandled rejection by forgetting a `.catch`
   * — which, on Node's default, takes the process down mid-session.
   */
  private write(
    scope: SettingsScope,
    what: string,
    transform: (config: SavedConfig) => SavedConfig,
  ): Promise<boolean> {
    const task = this.queue.then(async () => {
      await this.performWrite(scope, transform);
      this.invalidate();
    });

    // The queue itself must survive a failed write, or one EACCES wedges every
    // later save in the session.
    this.queue = task.catch(() => {});
    return task.then(() => true, (err: unknown) => {
      this.onError(`could not save ${what}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    });
  }

  /**
   * Like `write`, but for a save that spans more than one file and must be
   * seen as a single change — one invalidate/notify once every file has
   * settled, not one per file. A subscriber (the UI) would otherwise re-render
   * on a save that is only half done, showing a model pinned to a credential
   * that was never actually written, or the other way round.
   *
   * Each file is still written independently — one failing does not stop the
   * others, matching `write`'s per-scope error reporting — but the queue only
   * advances, and the snapshot only invalidates, once every one of them has
   * settled.
   */
  private writeMany(
    writes: Array<{ scope: SettingsScope; what: string; transform: (config: SavedConfig) => SavedConfig }>,
  ): Promise<boolean> {
    const task: Promise<boolean> = this.queue.then(async () => {
      const results = await Promise.all(writes.map(({ scope, what, transform }) =>
        this.performWrite(scope, transform).then(() => true, (err: unknown) => {
          this.onError(`could not save ${what}: ${err instanceof Error ? err.message : String(err)}`);
          return false;
        })));
      this.invalidate();
      return results.every(Boolean);
    });

    this.queue = task.then(() => {}, () => {});
    return task;
  }

  private invalidate(): void {
    this.memo = null;
    for (const listener of this.listeners) listener();
  }
}
