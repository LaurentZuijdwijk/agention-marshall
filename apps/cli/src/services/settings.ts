// ── runtime settings ──────────────────────────────────────────────────────────
//
// One owner for every non-secret setting: the shape, the reader, the resolver
// and the writer all live here, and nothing outside this file may reach into
// `SavedConfig` for a setting. That rule is the whole point — settings used to
// be read in three places (startup/profiles.ts, index.tsx, App.tsx) and written
// in two, which is how a value could be persisted in one shape and read back in
// another.
//
// There are deliberately *two* types, because "what a file pins" and "what this
// session runs with" are different questions and conflating them causes real
// bugs:
//
//   SettingsFile — sparse. Every field optional; absent means "not pinned".
//                  This is what a writer edits, so toggling the mode cannot
//                  accidentally freeze a safety level that was only ever a
//                  default into the file.
//   Settings     — resolved. Every field present, CLI flags applied. This is
//                  what the session and the header read, and it is never
//                  written back to disk.
//
// Two files can pin settings, and both are read (project wins, via
// `loadConfig`'s deep merge). A write picks one explicitly — see `SettingsScope`.
//
// Credentials never appear in either type. A judge is stored as
// provider/model/host only and is authenticated at load time from the global
// config or the environment, exactly like the main model is.

import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PROVIDER_DEFAULTS, resolveModel } from '@agentionai/marshall-engine';
import type { AgentProfile, Provider, SafetyAgentConfig, SafetyAgentKind } from '@agentionai/marshall-engine';
import { configPath, globalConfigPath, loadConfig, readJsonConfig } from './config-store.js';
import type { SavedConfig } from './config-store.js';

/**
 * The tool belt this session runs with.
 *
 * `agentic` is parsed and stored but not yet implemented — the `/runtime`
 * handler says so rather than silently doing nothing.
 */
export type RuntimeMode = 'default' | 'light' | 'agentic';

const RUNTIME_MODES: readonly RuntimeMode[] = ['default', 'light', 'agentic'];

/**
 * Levels that may be persisted.
 *
 * Level 1 (`yolo`) is missing on purpose and must stay missing: a gate that
 * turns itself off again on every launch, from a file that can be committed and
 * shared, is not a decision anyone should be able to make once.
 */
export type PersistedSafetyLevel = 2 | 3;

const SAFETY_AGENT_KINDS: readonly SafetyAgentKind[] = ['nvidia-content-safety', 'chat-judge'];

/** A level-3 judge as stored. Project-safe by construction: there is no `apiKey` field. */
export interface SavedSafetyAgent {
  provider: Provider;
  model: string;
  host?: string;
  kind?: SafetyAgentKind;
  maxOutputTokens?: number;
}

/**
 * Bumped only when an existing key changes meaning. A file whose version this
 * build does not recognise is ignored wholesale rather than half-read: a newer
 * CLI must not guess at an older shape, and an older CLI must not act on keys
 * it has never heard of.
 */
export const SETTINGS_VERSION = 1;

/** What is pinned in one file. An absent field means "not pinned, use the default". */
export interface SettingsFile {
  version: typeof SETTINGS_VERSION;
  runtime?: RuntimeMode;
  safetyLevel?: PersistedSafetyLevel;
  safetyAgent?: SavedSafetyAgent;
}

/** What this session runs with, after defaults and CLI flags. Never written. */
export interface Settings {
  runtime: RuntimeMode;
  safetyLevel: PersistedSafetyLevel;
  safetyAgent?: SavedSafetyAgent;
}

/** CLI flags that override the files. One-way by design — see `resolveSettings`. */
export interface SettingsFlags {
  light?: boolean;
}

/**
 * Which file a write lands in.
 *
 * `project` is the default because most settings are about how a particular
 * checkout is driven, and the file is safe to commit. `global` is what
 * `/runtime <mode> --global` asks for: "this is how I work, everywhere".
 */
export type SettingsScope = 'project' | 'global';

// ── reading ───────────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRuntime(raw: unknown): RuntimeMode | undefined {
  return RUNTIME_MODES.includes(raw as RuntimeMode) ? raw as RuntimeMode : undefined;
}

function readSafetyLevel(raw: unknown): PersistedSafetyLevel | undefined {
  return raw === 2 || raw === 3 ? raw : undefined;
}

/**
 * A stored judge, or `undefined` if it could not be trusted.
 *
 * Validated rather than cast. This is file content that becomes a network call
 * with an API key attached, and an unrecognised provider string cast straight
 * to `Provider` produces a judge that fails at review time — precisely when the
 * gate is supposed to be working.
 */
function readSafetyAgent(raw: unknown): SavedSafetyAgent | undefined {
  if (!isPlainObject(raw)) return undefined;
  const { provider, model, host, kind, maxOutputTokens } = raw;
  if (typeof provider !== 'string' || !(provider in PROVIDER_DEFAULTS)) return undefined;
  if (typeof model !== 'string' || !model.trim()) return undefined;
  return {
    provider: provider as Provider,
    model,
    ...(typeof host === 'string' ? { host } : {}),
    ...(SAFETY_AGENT_KINDS.includes(kind as SafetyAgentKind) ? { kind: kind as SafetyAgentKind } : {}),
    ...(typeof maxOutputTokens === 'number' && Number.isFinite(maxOutputTokens)
      ? { maxOutputTokens } : {}),
  };
}

/**
 * The settings pinned in a config, with anything unrecognised dropped.
 *
 * Pure, so the precedence and the validation are testable without a disk. Pass
 * the merged config (global ⊕ project) to learn what this workspace pins, or a
 * single file's contents to learn what that one file pins — a write needs the
 * latter, everything else the former.
 */
export function readSettings(config: SavedConfig): SettingsFile {
  const stored = config.settings;

  if (!isPlainObject(stored) || stored.version !== SETTINGS_VERSION) {
    // Fall back to the legacy top-level light flag so a file mid-migration
    // still gets a runtime value rather than drifting to the default.
    if (config.light === true) {
      return { version: SETTINGS_VERSION, runtime: 'light' };
    }
    return { version: SETTINGS_VERSION };
  }

  const runtime = readRuntime(stored.runtime);
  const safetyAgent = readSafetyAgent(stored.safetyAgent);
  // A level-3 gate with no usable judge would review nothing, so it degrades to
  // the human gate rather than to no gate. `settingsWarnings` says so out loud.
  const level = readSafetyLevel(stored.safetyLevel);
  const safetyLevel = level === 3 && !safetyAgent ? 2 : level;

  return {
    version: SETTINGS_VERSION,
    ...(runtime ? { runtime } : {}),
    ...(safetyLevel ? { safetyLevel } : {}),
    ...(safetyAgent ? { safetyAgent } : {}),
  };
}

/** What this repo alone pins, ignoring the global config. */
export function projectSettings(workspaceRoot: string): SettingsFile {
  return readSettings(readJsonConfig(configPath(workspaceRoot)));
}

/**
 * Config problems worth telling the user about, in the same spirit as
 * `danglingMcpSelections`: `readSettings` drops bad values silently so that a
 * hand-edited file cannot break startup, but a safety gate that quietly stopped
 * being the level you configured is not something to find out later.
 */
export function settingsWarnings(config: SavedConfig): string[] {
  const stored = config.settings;
  if (!isPlainObject(stored)) return [];
  if (stored.version !== SETTINGS_VERSION) {
    return [`config "settings" has version ${String(stored.version)}, which this build `
      + `does not understand (expected ${SETTINGS_VERSION}) — ignoring it. Upgrade with /update.`];
  }

  const warnings: string[] = [];
  const agent = readSafetyAgent(stored.safetyAgent);
  if (stored.runtime !== undefined && !readRuntime(stored.runtime)) {
    warnings.push(`settings.runtime "${String(stored.runtime)}" is not one of `
      + `${RUNTIME_MODES.join(', ')} — using default.`);
  }
  if (stored.safetyLevel !== undefined && !readSafetyLevel(stored.safetyLevel)) {
    warnings.push(`settings.safetyLevel ${String(stored.safetyLevel)} is not 2 or 3 — `
      + 'using 2, where you approve every state-changing call.');
  }
  if (stored.safetyAgent !== undefined && !agent) {
    warnings.push('settings.safetyAgent needs a known provider and a model — ignoring it. '
      + 'Run /safety agentic to choose a judge.');
  }
  // Reported separately from the judge itself: losing the judge and dropping a
  // level are two different facts, and the one the user cares about is that the
  // gate they configured is not the gate they got.
  if (readSafetyLevel(stored.safetyLevel) === 3 && !agent) {
    warnings.push('settings.safetyLevel is 3 but there is no usable judge — '
      + 'falling back to level 2, where you approve each call, rather than reviewing nothing.');
  }
  return warnings;
}

/**
 * What the session actually runs with.
 *
 * `--light` can turn the lean belt on but cannot turn a pinned runtime off, which
 * is the same one-way shape as `--github`: off is the default, so "unset it for
 * this run" is just not passing the flag.
 */
export function resolveSettings(file: SettingsFile, flags: SettingsFlags = {}): Settings {
  return {
    runtime: flags.light === true ? 'light' : file.runtime ?? 'default',
    safetyLevel: file.safetyLevel ?? 2,
    ...(file.safetyAgent ? { safetyAgent: file.safetyAgent } : {}),
  };
}

/** Read both files and resolve. The entry point for startup. */
export function loadSettings(workspaceRoot: string, flags: SettingsFlags = {}): Settings {
  return resolveSettings(readSettings(loadConfig(workspaceRoot)), flags);
}

// ── converting to and from the engine's shape ─────────────────────────────────
//
// Both directions live here so they cannot drift. The stored shape is a strict
// subset of the engine's: everything it drops is either a credential or derived.

/** Strip a live judge config down to what may be written to disk. */
export function toSavedSafetyAgent(agent: SafetyAgentConfig): SavedSafetyAgent {
  return {
    provider: agent.profile.provider,
    // Resolved rather than stored as `undefined`: the file should say which
    // model reviewed the calls, not "whatever the default was that week".
    model: resolveModel(agent.profile),
    ...(agent.profile.host !== undefined ? { host: agent.profile.host } : {}),
    ...(agent.kind ? { kind: agent.kind } : {}),
    ...(agent.maxOutputTokens !== undefined ? { maxOutputTokens: agent.maxOutputTokens } : {}),
  };
}

/** Where a stored judge gets its credential from, since the file has none. */
export interface JudgeAuth {
  /** The main agent, whose key the judge may share. */
  mainProfile: AgentProfile;
  /** Per-provider keys from the global config, keyed by provider. */
  savedKeys?: Record<string, string | undefined>;
}

/**
 * Turn a stored judge into something the engine can actually call.
 *
 * The key is the whole difficulty. A judge that cannot authenticate is
 * unreachable, and an unreachable judge at level 3 means every call falls back
 * to the human gate — safe, but not what was configured. So it is resolved the
 * same way the main model's is:
 *
 *   1. the main agent's key, but only when the judge shares its provider *and*
 *      is not pointed at some other host. A different host is a different
 *      service, and handing it a key for this one is how a committed config
 *      file turns into credential exfiltration.
 *   2. that provider's own key from the *global* config.
 *   3. nothing, and the engine's `resolveAuth` falls back to the provider's
 *      environment variable, which is how a `.env` supplies it.
 */
export function toSafetyAgentConfig(saved: SavedSafetyAgent, auth: JudgeAuth): SafetyAgentConfig {
  const { mainProfile, savedKeys } = auth;
  const sameProvider = mainProfile.provider === saved.provider;
  const sameHost = saved.host === undefined || saved.host === mainProfile.host;
  const apiKey = sameProvider && sameHost
    ? mainProfile.apiKey ?? savedKeys?.[saved.provider]
    : savedKeys?.[saved.provider];

  return {
    profile: {
      provider: saved.provider,
      model: saved.model,
      ...(saved.host !== undefined ? { host: saved.host } : {}),
      ...(apiKey ? { apiKey } : {}),
    },
    ...(saved.kind ? { kind: saved.kind } : {}),
    ...(saved.maxOutputTokens !== undefined ? { maxOutputTokens: saved.maxOutputTokens } : {}),
  };
}

// ── writing ───────────────────────────────────────────────────────────────────

/** Drop keys explicitly set to `undefined`, so an update can remove a pin. */
function compact(settings: SettingsFile): SettingsFile {
  return Object.fromEntries(
    Object.entries(settings).filter(([, value]) => value !== undefined),
  ) as unknown as SettingsFile;
}

/**
 * The only writer.
 *
 * `update` is handed what the target file alone pins, not the merged view, so
 * `s => ({ ...s, runtime: 'light' })` records exactly one decision instead of
 * freezing every inherited default into the file. Returning a field as
 * `undefined` removes the pin.
 *
 * Everything else in the file is preserved, and the global file keeps its
 * `0600` because it holds credentials. Callers fire and forget: a failed write
 * costs the user a re-run of the command, not the session.
 */
export async function saveSettings(
  workspaceRoot: string,
  update: (current: SettingsFile) => SettingsFile,
  scope: SettingsScope = 'project',
): Promise<void> {
  const path = scope === 'global' ? globalConfigPath() : configPath(workspaceRoot);
  await mkdir(dirname(path), { recursive: true });

  let existing: SavedConfig = {};
  try {
    existing = JSON.parse(await readFile(path, 'utf8')) as SavedConfig;
  } catch { /* no file yet, or unreadable — start from empty */ }

  const next = compact({ ...update(readSettings(existing)), version: SETTINGS_VERSION });
  // `light` is deleted rather than left behind: it has just been folded into
  // `settings.runtime`, and a file carrying both would answer the same question
  // two ways depending on which build read it.
  const { light: _absorbed, ...rest } = existing;
  const json = JSON.stringify({ ...rest, settings: next }, null, 2) + '\n';
  await writeFile(path, json, scope === 'global' ? { mode: 0o600 } : {});
  // `mode` on writeFile only applies when the file is created, and the global
  // config normally already exists. Tighten it explicitly, so a file that was
  // once created loosely does not stay that way while holding an API key.
  if (scope === 'global') await chmod(path, 0o600);
}
