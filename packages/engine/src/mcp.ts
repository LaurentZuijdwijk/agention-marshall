import { MCPClient } from '@agentionai/agents/core';
import type { Tool } from '@agentionai/agents/core';
import { adaptMcpTools } from '@agentionai/marshall-tools';
import type { ToolConfig } from '@agentionai/marshall-tools';

/**
 * Connections to remote MCP servers, and the tools they offer.
 *
 * Owns lifecycle only. The safety wrapping — namespacing, never-throw,
 * stringification, timeouts, the approval gate — lives in `adaptMcpTools` in
 * the tools package, so a second consumer gets it without reimplementing it.
 *
 * The governing rule is that a remote server is the least trustworthy and least
 * available thing in the process: nothing here throws, an unreachable server
 * degrades to a reported error rather than a broken session, and a slow one
 * cannot hold up a turn indefinitely.
 */

/** Ceiling on the initial handshake. An unreachable host must not stall a turn. */
const CONNECT_TIMEOUT_MS = 15_000;

export interface McpServerConfig {
  /** Local name — namespaces the tools and identifies the server in `/mcp`. */
  name: string;
  /** Full URL of the MCP endpoint. */
  url: string;
  /** Static auth headers, e.g. `{ Authorization: 'Bearer …' }`. */
  headers?: Record<string, string>;
  /** Configured but not connected when false. Default: true. */
  enabled?: boolean;
}

export type McpStatus = 'idle' | 'connecting' | 'connected' | 'error' | 'disabled';

export interface McpServerState {
  name: string;
  url: string;
  status: McpStatus;
  /** Namespaced names, so what is shown is what the model actually sees. */
  toolNames: string[];
  error?: string;
}

interface ServerRecord {
  config: McpServerConfig;
  client: MCPClient | null;
  tools: Tool<unknown>[];
  status: McpStatus;
  error?: string;
}

export class McpRegistry {
  private readonly servers = new Map<string, ServerRecord>();
  /** Resolves when every server has settled — connected or failed. */
  private settled: Promise<void> = Promise.resolve();

  constructor(configs: McpServerConfig[] = []) {
    for (const config of configs) this.put(config);
  }

  private put(config: McpServerConfig): ServerRecord {
    const record: ServerRecord = {
      config,
      client: null,
      tools: [],
      status: config.enabled === false ? 'disabled' : 'idle',
    };
    this.servers.set(config.name, record);
    return record;
  }

  /** True when nothing is configured — lets the session skip all of this. */
  get isEmpty(): boolean {
    return this.servers.size === 0;
  }

  /** Start connecting everything enabled. Safe to call more than once. */
  connectAll(): Promise<void> {
    this.settled = Promise.all(
      [...this.servers.values()]
        .filter(r => r.status !== 'disabled')
        .map(r => this.open(r)),
    ).then(() => {});
    return this.settled;
  }

  /** Await whatever `connectAll` started, without starting anything new. */
  ready(): Promise<void> {
    return this.settled;
  }

  private async open(record: ServerRecord): Promise<void> {
    record.status = 'connecting';
    record.error = undefined;
    try {
      const client = MCPClient.fromUrl(record.config.url, {
        clientName: 'marshall',
        ...(record.config.headers ? { headers: record.config.headers } : {}),
      });
      // MCPClient.connect has no timeout of its own, and a URL that accepts a
      // socket but never completes the handshake would otherwise hang the first
      // turn with no way to interrupt it.
      await withTimeout(client.connect(), CONNECT_TIMEOUT_MS, 'connection timed out');
      record.client = client;
      record.tools = client.getTools();
      record.status = 'connected';
    } catch (err) {
      record.client = null;
      record.tools = [];
      record.status = 'error';
      record.error = err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * Wrapped tools from every connected server.
   *
   * Rebuilt per turn from the caller's `ToolConfig`, because the approval
   * function, abort signal and caller identity are all per-turn — the raw
   * discovered tools are what persist.
   */
  tools(config: ToolConfig): Tool<string>[] {
    const out: Tool<string>[] = [];
    for (const record of this.servers.values()) {
      if (record.status !== 'connected' || record.tools.length === 0) continue;
      out.push(...adaptMcpTools(record.tools, config, { server: record.config.name }));
    }
    return out;
  }

  /** What `/mcp` renders. */
  state(): McpServerState[] {
    return [...this.servers.values()].map(record => ({
      name: record.config.name,
      url: record.config.url,
      status: record.status,
      toolNames: adaptedNames(record),
      ...(record.error ? { error: record.error } : {}),
    }));
  }

  get configs(): McpServerConfig[] {
    return [...this.servers.values()].map(r => r.config);
  }

  has(name: string): boolean {
    return this.servers.has(name);
  }

  /** Add a server and connect it immediately, so the caller can report the
   *  outcome rather than leaving the user to guess whether it worked. */
  async add(config: McpServerConfig): Promise<McpServerState> {
    await this.removeServer(config.name);
    const record = this.put(config);
    if (record.status !== 'disabled') await this.open(record);
    return this.state().find(s => s.name === config.name)!;
  }

  async remove(name: string): Promise<boolean> {
    return this.removeServer(name);
  }

  private async removeServer(name: string): Promise<boolean> {
    const record = this.servers.get(name);
    if (!record) return false;
    await close(record);
    this.servers.delete(name);
    return true;
  }

  /** Drop and re-open a connection — the fix for a server that went away. */
  async reconnect(name: string): Promise<McpServerState | null> {
    const record = this.servers.get(name);
    if (!record) return null;
    await close(record);
    record.status = record.config.enabled === false ? 'disabled' : 'idle';
    if (record.status !== 'disabled') await this.open(record);
    return this.state().find(s => s.name === name)!;
  }

  /** Close everything. Called from Session.dispose(). */
  async disconnect(): Promise<void> {
    await Promise.all([...this.servers.values()].map(close));
  }
}

function adaptedNames(record: ServerRecord): string[] {
  if (record.status !== 'connected') return [];
  // Read through getPrompt rather than `.name`, for the same reason the adapter
  // does: it is the public accessor for a Tool's advertised triple.
  return record.tools.map(t => t.getPrompt().name);
}

async function close(record: ServerRecord): Promise<void> {
  const client = record.client;
  record.client = null;
  record.tools = [];
  if (!client) return;
  // A disconnect that throws must not stop the rest of teardown.
  try {
    await withTimeout(client.disconnect(), CONNECT_TIMEOUT_MS, 'disconnect timed out');
  } catch { /* the connection is going away regardless */ }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
