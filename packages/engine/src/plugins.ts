import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { createBackgroundJobs } from '@agentionai/marshall-tools';
import type { BackgroundJob, BackgroundJobs } from '@agentionai/marshall-tools';
import type { McpRegistry } from './mcp.js';

/**
 * A "server-backed" plugin: something that starts a local server and hands
 * the model MCP tools once it's up. This is the minimal real slice of the
 * plugin system this repo designed but never implemented (see the
 * marshall-plugin-system-design notes) — scoped to exactly one capability:
 * enable/disable a locally-spawned plugin, auto-registered as an MCP server.
 * The fuller hook system (approval racing, paid npm plugins) is future work
 * that can build on this without reworking it.
 */

export interface PluginConfig {
  /** npm package (or subpath) to dynamically import — e.g.
   *  '@agentionai/marshall-plugin-browser/plugin'. */
  package: string;
  /** Local name — the /plugins command's handle, and the McpServerConfig.name
   *  it registers under. */
  name: string;
  /** Secret this plugin's server needs for its own side channel (e.g. a
   *  browser extension's pairing token). Persisted only in the global
   *  config — never a project-committable field, same rule as an MCP
   *  server's `headers`. */
  token?: string;
  /** Last selected loopback port; preferred on subsequent launches. */
  port?: number;
  /** Configured but not auto-enabled at session start when false. Default: true. */
  enabled?: boolean;
}

export type PluginStatus = 'idle' | 'starting' | 'running' | 'error' | 'disabled';

export interface PluginState {
  name: string;
  package: string;
  status: PluginStatus;
  port?: number;
  error?: string;
}

/**
 * The structural contract a plugin package's `marshallPlugin` (or default)
 * export must satisfy. Never imported as a shared type — `packages/engine`
 * never depends on a specific plugin package, it only dynamically `import()`s
 * whatever `PluginConfig.package` names and duck-types the result. See
 * `packages/plugin-browser/src/plugin.ts` for the reference implementation.
 */
export interface MarshallServerPlugin {
  name: string;
  defaultPort: number;
  resolveEntryPath(): string;
  buildLaunch(opts: { port: number; token: string }): { args: string[]; env: Record<string, string> };
  healthPath: string;
  /** Require this `plugin` value in health JSON before reusing a server. */
  healthIdentity?: string;
  mcpPath: string;
}

export interface PluginRegistryDeps {
  mcp: McpRegistry;
  /** Overridable so tests don't have to wait out the real, multi-second
   *  defaults — production code never sets these. */
  healthTimeoutMs?: number;
  startupTimeoutMs?: number;
  startupPollIntervalMs?: number;
}

/** Single health probe's ceiling — a fast local check, not a real request. */
const HEALTH_TIMEOUT_MS = 1_500;
/** How long `enable` waits for a freshly-spawned process to answer healthy. */
const STARTUP_TIMEOUT_MS = 10_000;
const STARTUP_POLL_INTERVAL_MS = 300;
/** setTimeout's own ceiling (a 32-bit signed ms count) — "for the rest of
 *  this session" in practice; real cleanup is `disposeAll()` on
 *  `Session.dispose()`, not this timer ever firing. */
const SESSION_LIFETIME_MS = 2_147_483_647;

interface PluginRecord {
  config: PluginConfig;
  status: PluginStatus;
  error?: string;
  /** Set only when this registry spawned the process — never set for a
   *  manually-started instance we merely detected via a health probe, so
   *  `disable` never kills something it didn't start. */
  jobId?: string;
}

/**
 * Owns plugin definitions and, for enabled ones, the spawned process (if any)
 * and the MCP registration it exposes. Mirrors `McpRegistry`'s shape and its
 * "never throw, degrade to an error state" posture.
 */
export class PluginRegistry {
  private readonly records = new Map<string, PluginRecord>();
  /** A dedicated instance, not `Session`'s own `jobs` — a plugin's server
   *  process is infrastructure the CLI manages, not something the agent
   *  started via `run_shell background: true`, and mixing the two would
   *  make `/jobs list` show a process the user never asked for. */
  private readonly jobs: BackgroundJobs;

  constructor(configs: PluginConfig[], private readonly deps: PluginRegistryDeps) {
    this.jobs = createBackgroundJobs({ onExit: (job) => this.onJobExit(job) });
    for (const config of configs) {
      this.records.set(config.name, {
        config,
        status: config.enabled === false ? 'disabled' : 'idle',
      });
    }
  }

  /**
   * Register (or replace) a plugin's definition, then enable it — the "no
   * separate install step" path: the CLI hands this a `{ package, name }` it
   * looked up itself (see apps/cli's known-plugins.ts) the first time a name
   * isn't configured yet. Mirrors `McpRegistry.add`.
   */
  async add(config: PluginConfig): Promise<{ state: PluginState; generatedToken?: string }> {
    const existing = this.records.get(config.name);
    this.records.set(config.name, {
      config: { ...config, port: config.port ?? existing?.config.port, token: config.token ?? existing?.config.token },
      status: config.enabled === false ? 'disabled' : 'idle',
      jobId: existing?.jobId,
    });
    if (config.enabled === false) return { state: this.toState(this.records.get(config.name)!) };
    return this.enable(config.name);
  }

  /** Enable every configured plugin whose `enabled !== false`. Never throws —
   *  one plugin failing to start must not stop the others or the session. */
  async enableAll(): Promise<void> {
    await Promise.all(
      [...this.records.values()]
        .filter(r => r.status !== 'disabled')
        .map(r => this.enable(r.config.name).catch(() => {})),
    );
  }

  /**
   * Bring one plugin up: load its module, reuse or spawn its server, wait for
   * it to answer healthy, then register it as an MCP server.
   *
   * `generatedToken` is present only when this call minted a fresh token
   * (no `token` was configured yet) — the caller's cue to show it to the
   * human, since it won't be shown again once persisted.
   */
  async enable(name: string): Promise<{ state: PluginState; generatedToken?: string }> {
    const record = this.records.get(name);
    if (!record) {
      return { state: { name, package: '', status: 'error', error: `no plugin named "${name}" is configured` } };
    }

    record.status = 'starting';
    record.error = undefined;

    try {
      const plugin = await loadPlugin(record.config.package);
      let port = record.config.port ?? plugin.defaultPort;
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('plugin port must be an integer between 1 and 65535');
      }
      const healthUrl = () => `http://127.0.0.1:${port}${plugin.healthPath}`;
      const healthTimeoutMs = this.deps.healthTimeoutMs ?? HEALTH_TIMEOUT_MS;
      const startupTimeoutMs = this.deps.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
      const startupPollIntervalMs = this.deps.startupPollIntervalMs ?? STARTUP_POLL_INTERVAL_MS;

      // A manually-started instance (or one a previous enable — ours or
      // another session's — left running) means there's nothing to spawn,
      // so a token is never minted here either: we'd have no way to know if
      // it actually matches what that server was launched with, and
      // handing the human a token that doesn't pair is worse than handing
      // them none. Only the caller that actually launches the process can
      // be sure its token is the right one.
      let generatedToken: string | undefined;
      const alreadyUp = await probeHealth(healthUrl(), healthTimeoutMs, plugin.healthIdentity);
      if (!alreadyUp) {
        // An owned but unhealthy process must not be orphaned when moving ports.
        if (record.jobId) this.jobs.kill(record.jobId);
        record.jobId = undefined;
        const token = record.config.token ?? (generatedToken = generateToken());
        record.config = { ...record.config, token };

        // Try the remembered/default port, or let the OS select a free one.
        // The child binds separately, so retry only a confirmed bind collision
        // if another process wins the short gap after our reservation closes.
        for (let attempt = 0; attempt < 3; attempt++) {
          port = await availablePort(attempt === 0 ? port : 0);
          const { args, env } = plugin.buildLaunch({ port, token });
          const command = ['node', quoteArg(plugin.resolveEntryPath()), ...args.map(quoteArg)].join(' ');
          const job = this.jobs.start({
            command,
            cwd: process.cwd(),
            timeoutMs: SESSION_LIFETIME_MS,
            extraEnv: env,
          });
          record.jobId = job.id;

          const healthy = await waitForHealth(
            healthUrl(), startupTimeoutMs, startupPollIntervalMs, healthTimeoutMs,
            plugin.healthIdentity, () => this.jobs.get(job.id)?.status !== 'running',
          );
          if (!healthy) {
            const collision = this.jobs.tail(job.id)?.stderr.includes('EADDRINUSE');
            this.jobs.kill(job.id);
            record.jobId = undefined;
            if (collision && attempt < 2) continue;
            record.status = 'error';
            record.error = `${name} did not become healthy within ${(startupTimeoutMs / 1000).toFixed(0)}s`;
            return { state: this.toState(record) };
          }
          break;
        }
      }
      record.config = { ...record.config, port };

      // A few retries with backoff: `/health` answering doesn't guarantee the
      // full MCP handshake will too, a beat later, on a server whose HTTP
      // listener just opened — an immediately-following connect can still
      // race a freshly-spawned process (or a host under heavy load) and land
      // on a bare connection reset rather than a clean refusal.
      const mcpUrl = `http://127.0.0.1:${port}${plugin.mcpPath}`;
      let mcpState = await this.deps.mcp.add({ name, url: mcpUrl });
      for (let attempt = 0; mcpState.status !== 'connected' && attempt < 3; attempt++) {
        await sleep(startupPollIntervalMs * (attempt + 1));
        mcpState = await this.deps.mcp.add({ name, url: mcpUrl });
      }
      if (mcpState.status !== 'connected') {
        record.status = 'error';
        record.error = mcpState.error ?? "connected to the plugin's server, but its MCP endpoint refused";
        return { state: this.toState(record) };
      }

      record.status = 'running';
      return { state: this.toState(record), generatedToken };
    } catch (err) {
      record.status = 'error';
      record.error = err instanceof Error ? err.message : String(err);
      return { state: this.toState(record) };
    }
  }

  /** Unregisters the MCP entry and kills the process if this registry
   *  started one. The config entry (and its token) survive, so re-enabling
   *  later doesn't force re-pairing whatever the plugin's own client is. */
  async disable(name: string): Promise<boolean> {
    const record = this.records.get(name);
    if (!record) return false;
    await this.deps.mcp.remove(name);
    if (record.jobId) this.jobs.kill(record.jobId);
    record.jobId = undefined;
    record.status = 'disabled';
    record.error = undefined;
    return true;
  }

  state(): PluginState[] {
    return [...this.records.values()].map(r => this.toState(r));
  }

  /** Current effective config, token included — what the caller persists.
   *  The registry owns the live token/enabled state; the config file only
   *  ever records it, the same relationship `McpRegistry.configs` has with
   *  `withMcpServers`. */
  configs(): PluginConfig[] {
    return [...this.records.values()].map(r => ({
      ...r.config,
      enabled: r.status !== 'disabled',
    }));
  }

  /** Kill every process this registry started. Called from `Session.dispose()`. */
  async disposeAll(): Promise<void> {
    this.jobs.killAll();
  }

  private toState(record: PluginRecord): PluginState {
    return {
      name: record.config.name,
      package: record.config.package,
      status: record.status,
      ...(record.config.port !== undefined ? { port: record.config.port } : {}),
      ...(record.error ? { error: record.error } : {}),
    };
  }

  /** A process that died on its own (crash, manual kill outside our
   *  control) — not one `disable` stopped, which already updates status
   *  itself. A stale MCP registration pointing at a dead server is worse
   *  than none, so it's dropped here too. */
  private onJobExit(job: BackgroundJob): void {
    for (const record of this.records.values()) {
      if (record.jobId !== job.id) continue;
      record.jobId = undefined;
      if (record.status === 'running') {
        record.status = 'error';
        record.error = 'the plugin process exited unexpectedly';
        void this.deps.mcp.remove(record.config.name);
      }
    }
  }
}

async function loadPlugin(specifier: string): Promise<MarshallServerPlugin> {
  const mod: unknown = await import(specifier);
  const candidate = (mod as { marshallPlugin?: unknown }).marshallPlugin
    ?? (mod as { default?: unknown }).default;
  if (!isMarshallServerPlugin(candidate)) {
    throw new Error(`"${specifier}" does not export a valid marshallPlugin`);
  }
  return candidate;
}

function isMarshallServerPlugin(value: unknown): value is MarshallServerPlugin {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.name === 'string'
    && typeof v.defaultPort === 'number'
    && typeof v.resolveEntryPath === 'function'
    && typeof v.buildLaunch === 'function'
    && typeof v.healthPath === 'string'
    && typeof v.mcpPath === 'string';
}

/** Not the crypto boundary itself — that's the plugin's own concern (see
 *  packages/plugin-browser/src/token.ts) — just enough entropy that this
 *  registry never hands out the same secret twice. */
function generateToken(): string {
  return randomBytes(24).toString('base64url');
}

/** Wrapped in quotes since `resolveEntryPath()`/args become one shell
 *  string for `BackgroundJobs.start` (`sh -c <command>`) — an unquoted path
 *  with a space would otherwise split into two argv entries. */
function quoteArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function probeHealth(url: string, healthTimeoutMs: number, identity?: string): Promise<boolean> {
  try {
    const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(healthTimeoutMs) });
    if (!res.ok) { await res.body?.cancel(); return false; }
    if (identity === undefined) { await res.body?.cancel(); return true; }
    const body = await res.json() as { ok?: unknown; plugin?: unknown };
    return body?.ok === true && body?.plugin === identity;
  } catch {
    return false;
  }
}

async function waitForHealth(
  url: string,
  timeoutMs: number,
  pollIntervalMs: number,
  healthTimeoutMs: number,
  identity?: string,
  exited: () => boolean = () => false,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited()) return false;
    if (await probeHealth(url, healthTimeoutMs, identity) && !exited()) return true;
    await sleep(pollIntervalMs);
  }
  return false;
}

/** Bind rather than scan: never send probes to arbitrary services on a port range. */
async function availablePort(preferred: number): Promise<number> {
  try {
    return await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(preferred, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        server.close(err => err ? reject(err) : resolve(port));
      });
    });
  } catch (err) {
    if (preferred !== 0 && (err as NodeJS.ErrnoException).code === 'EADDRINUSE') return availablePort(0);
    throw err;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
