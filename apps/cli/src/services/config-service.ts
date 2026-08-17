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
//   2. One write path. `writeMany()` is the only thing in the app that opens a
//      config file for writing. Everything public is a *transform* handed to
//      it, applied to whatever is on disk at the moment it runs — never a
//      precomputed value, which would encode a stale read and could not be
//      re-applied to a fresh one.
//
// Writes are serialised through a promise chain, so two settings changed in the
// same tick cannot each read the file before the other writes it. The chain
// only reaches this process: against another instance, or a hand edit, every
// save fingerprints the files it read, checks the fingerprint still holds
// before writing, and re-applies the transforms to whatever landed in between
// rather than clobbering it. The file itself is replaced by temp file +
// rename, so no reader — this process or another — ever sees a half-written
// file: one read back through the lenient parser is an *empty* config, which
// for the global file means every stored key, gone silently.

import { writeFile, mkdir, chmod, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AgentProfile, McpServerConfig } from '@agentionai/marshall-engine';
import {
  configPath, findProvider, globalConfigPath, legacyProfileWarnings, loadConfig, loadMcpWarnings,
  projectSecretWarnings, providerCredentials, providerKeyForHost, readJsonConfig, removeProvider,
  repairConfig, resolveMcpServers, validateForWrite, withAgents, withMcpServers, withModelSelection,
  withProjectMcp, withProviderCredentials,
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

/**
 * Both raw files as one value — what every write transform is handed, so a
 * transform may consult the layer it is not writing to.
 */
export interface ConfigFiles {
  global: SavedConfig;
  project: SavedConfig;
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

  /**
   * Re-read the files on the next `snapshot()` — for a display that wants the
   * current truth rather than the last thing this process wrote, e.g. the
   * settings menu opening after another instance saved something.
   *
   * Deliberately touches nothing the session runs on: this process's profiles
   * are pinned at startup, and only an in-session `/model` changes them. A
   * write from another instance changes what the *display* shows, not the
   * model this session talks to.
   */
  refresh(): void {
    this.invalidate();
  }

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
      { scope: 'global', what: 'provider credentials', transform: files => withProviderCredentials(files.global, deep, fast) },
      { scope: 'project', what: 'model selection', transform: files => withModelSelection(files.project, deep, fast) },
    ]);
  }

  /**
   * Fix the config problems `config-store.ts`'s `repairConfig` knows how to
   * fix unambiguously — a pre-tier flat model choice, or an `apiKey` that
   * leaked into the committed project file — and report what changed, empty
   * when there was nothing to do.
   *
   * `repairConfig` needs both raw files together — a leaked project key is
   * filed under the global providers list, not left where it was — so both
   * transforms below are handed the pair and each takes its own file's result
   * out of the same pure computation. The computation runs inside the queued
   * task, not from `snapshot()`'s memo: a repair computed from a stale read
   * could redo, or silently undo, whatever the write immediately ahead of it
   * in the queue just did — and because it is a transform of the freshly read
   * files, the fingerprint check protects it against another instance the way
   * every other write is protected, instead of writing a value a stale read
   * baked in.
   */
  /**
   * Resolves `null` when the write itself failed (already reported via
   * `onError`) rather than an empty list — the two must stay distinguishable,
   * or a failed repair reads to the caller as "there was nothing to fix".
   */
  repair(): Promise<string[] | null> {
    let actions: string[] = [];
    // `apply` runs once per scope below, each time recomputing `repairConfig`
    // over the same `files` pair rather than sharing one result — `writeMany`
    // calls each entry's `transform` independently, so there is no single call
    // site to compute it once from. `actions` is overwritten, not merged, on
    // each call: correct only because `repairConfig` is pure and deterministic
    // over the same input, so both calls land on the same actions list
    // regardless of which one runs last. That purity is what `repairConfig`'s
    // own tests pin — if it ever stopped holding, this would silently report
    // one scope's actions while writing both.
    const apply = (files: ConfigFiles, scope: SettingsScope): SavedConfig => {
      const result = repairConfig(files.global, files.project);
      actions = result.actions;
      return scope === 'global'
        ? result.global ?? files.global
        : result.project ?? files.project;
    };
    return this.writeMany([
      { scope: 'global', what: 'repaired config', transform: files => apply(files, 'global') },
      { scope: 'project', what: 'repaired config', transform: files => apply(files, 'project') },
    ]).then(ok => (ok ? actions : null));
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
    // Checked inside the queued task, not before it: a read outside the queue
    // can race a write queued just ahead of this one. Each file is only
    // written when the transform actually changed it — see `writeMany` — so an
    // entry that only ever lived in the global one does not create a project
    // file out of nothing.
    let removed = false;
    const drop = (scope: SettingsScope) => (files: ConfigFiles): SavedConfig => {
      const config = files[scope];
      if (findProvider(config.providers, ref) !== undefined) removed = true;
      // No list in this file — nothing to drop here, and adding an empty one
      // would create (or bloat) a file the entry never touched.
      if (config.providers === undefined) return config;
      return { ...config, providers: removeProvider(config.providers, ref) };
    };
    return this.writeMany([
      { scope: 'global', what: 'provider list', transform: drop('global') },
      { scope: 'project', what: 'provider list', transform: drop('project') },
    ]).then(ok => ok && removed);
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

  /**
   * Both raw files as one value, handed to every transform. Transforms may
   * need the other layer — `repair` moves a leaked project key into the global
   * list — and the fingerprint below needs both at once.
   */
  private fingerprint(files: ConfigFiles): string {
    return JSON.stringify([files.global, files.project]);
  }

  /**
   * The whole save protocol, in one place: read both files, apply every
   * transform to the pair, validate the results, check nothing changed under
   * us, write every changed file atomically, invalidate once.
   *
   * The fingerprint check is what the queue cannot do: the queue serialises
   * *this* process, while another instance — or a hand edit — writes straight
   * to the file. When the fingerprint no longer holds, the transforms are
   * re-applied to the fresh content, which *is* the merge: a transform is a
   * pure, idempotent function of (files, intent), so re-running it over
   * whatever the other writer left keeps the other writer's entries and lands
   * ours on top.
   *
   * A save that spans more than one file is seen as a single change — one
   * invalidate/notify once every file has settled — so a subscriber never
   * re-renders on a save that is only half done. Only files whose content
   * actually changed are written, and each file is still written
   * independently — one failing does not stop the others, matching the
   * per-scope error reporting.
   *
   * Never rejects: failures go to `onError` and the promise resolves `false`,
   * so no call site can produce an unhandled rejection by forgetting a
   * `.catch` — which, on Node's default, takes the process down mid-session.
   */
  private static readonly WRITE_ATTEMPTS = 3;

  private writeMany(
    writes: Array<{ scope: SettingsScope; what: string; transform: (files: ConfigFiles) => SavedConfig }>,
  ): Promise<boolean> {
    const task: Promise<boolean> = this.queue.then(async () => {
      const paths = { global: globalConfigPath(), project: configPath(this.workspaceRoot) };
      for (let attempt = 1; ; attempt++) {
        // From disk, not from `this.memo`: the memo is a rendering convenience
        // and may predate another writer's change.
        const files: ConfigFiles = {
          global: readJsonConfig(paths.global),
          project: readJsonConfig(paths.project),
        };
        const seen = this.fingerprint(files);
        const results = new Map<SettingsScope, { what: string; next: SavedConfig }>();
        for (const write of writes) {
          const next = write.transform(files);
          const invalid = validateForWrite(next, files[write.scope]);
          if (invalid) throw new Error(`${write.what}: ${invalid}`);
          results.set(write.scope, { what: write.what, next });
        }
        // Someone else may have written while we were reading: if so, re-apply
        // the transforms to the fresh content rather than clobber it.
        const now: ConfigFiles = {
          global: readJsonConfig(paths.global),
          project: readJsonConfig(paths.project),
        };
        if (this.fingerprint(now) !== seen) {
          if (attempt >= ConfigService.WRITE_ATTEMPTS) {
            throw new Error('the config file keeps changing between read and write; giving up');
          }
          continue;
        }
        let ok = true;
        for (const [scope, { what, next }] of results) {
          if (JSON.stringify(next) === JSON.stringify(files[scope])) continue;
          try {
            await this.writeFileAtomic(paths[scope], next, scope === 'global');
          } catch (err) {
            ok = false;
            this.onError(`could not save ${what}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (ok) this.invalidate();
        return ok;
      }
    });

    // The queue itself must survive a failed write, or one EACCES wedges every
    // later save in the session. The returned promise must resolve, never
    // reject: a validation failure or a give-up throws inside the task, and a
    // call site that forgot its `.catch` would otherwise take the process
    // down mid-session. Per-file write failures never reject — they are
    // reported inside the loop and resolved as `false`.
    this.queue = task.then(() => {}, () => {});
    return task.then(
      () => true,
      (err: unknown) => {
        this.onError(err instanceof Error ? err.message : String(err));
        return false;
      },
    );
  }

  /**
   * Read one target file, transform it, write it back — `writeMany` with a
   * single file, for a save that only touches one of the two. Queued: the
   * transform runs against what is on disk at the moment it is its turn, not
   * against what was there when the caller asked. Two settings changed in one
   * tick therefore compose instead of the second overwriting the first with a
   * stale base.
   */
  private write(
    scope: SettingsScope,
    what: string,
    transform: (config: SavedConfig) => SavedConfig,
  ): Promise<boolean> {
    return this.writeMany([{ scope, what, transform: files => transform(files[scope]) }]);
  }

  /**
   * The only thing that opens a config file for writing: temp file + rename,
   * so no reader ever sees a half-written file. A torn file read back through
   * the lenient parser is an *empty* config — for the global file, every
   * stored key, gone silently — which is where the old plain `writeFile` went
   * when the process died mid-save.
   *
   * `0600` is set on the temp file *before* the rename, not on the target
   * after: the file has the right mode at the moment it becomes visible, and a
   * file once created loosely does not stay that way while holding an API key.
   *
   * Only the global file holds a secret — `secret` is false for the project
   * file, which is meant to be committed and read by anyone who clones the
   * repo, so it keeps the default creation mode instead of being locked to
   * the writing user.
   */
  private async writeFileAtomic(path: string, config: SavedConfig, secret: boolean): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(config, null, 2) + '\n', secret ? { mode: 0o600 } : undefined);
      if (secret) await chmod(tmp, 0o600);
      await rename(tmp, path);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  private invalidate(): void {
    this.memo = null;
    for (const listener of this.listeners) listener();
  }
}
