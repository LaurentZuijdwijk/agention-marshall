import { Tool } from '@agentionai/agents/core';
import type { ToolConfig, ToolSpec, ToolSource } from '../types.js';
import { withApproval } from './approval.js';

/**
 * Make an MCP server's tools safe to hand to an agent.
 *
 * Agention's MCPClient already turns MCP tools into `Tool` instances, so this is
 * not about protocol — it is about the three ways those tools break the
 * contract every other tool here honours:
 *
 *   1. Their `execute` throws. On a failed call, and on a disconnected client.
 *      A tool that throws takes down the agent turn instead of telling the model
 *      something went wrong, and a remote server is the single most likely thing
 *      in this process to be unreachable.
 *   2. Their `execute` does not always return a string. MCP `structuredContent`
 *      comes back as an object, which renders as "[object Object]" and puts a
 *      non-string into history.
 *   3. They ignore cancellation entirely. Nothing threads an AbortSignal to a
 *      remote call, so a hung server means an un-interruptible turn.
 *
 * On top of that they are the only tools here whose *name and description* are
 * written by someone else, which is why names are namespaced (a server offering
 * `read_file` must not shadow ours) and why they are gated by default.
 */

/** Cap on a single MCP call. Remote servers have no timeout of their own here. */
export const DEFAULT_MCP_TIMEOUT_MS = 60_000;

/** Sub-namespace separator, matching the convention MCP hosts have converged on. */
const NAMESPACE = 'mcp__';

/** The local, collision-proof name for a server's tool. */
export function namespaceMcpTool(server: string, toolName: string): string {
  return `${NAMESPACE}${sanitise(server)}__${toolName}`;
}

/** Server names reach us from user config, but tool names must stay simple
 *  identifiers — providers reject names outside `[a-zA-Z0-9_-]`. */
function sanitise(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export interface McpToolOptions {
  /** The local name for the server this tool belt came from. */
  server: string;
  /** Per-call ceiling. Default: 60 s. */
  timeoutMs?: number;
}

/**
 * Wrap already-discovered MCP tools (`MCPClient.getTools()`).
 *
 * Takes the tools rather than the client on purpose: connection lifecycle is the
 * engine's business, and keeping it out of here means this stays a pure function
 * that a test can drive with a hand-built Tool and no server.
 */
export function adaptMcpTools(
  tools: Tool<unknown>[],
  config: ToolConfig,
  options: McpToolOptions,
): Tool<string>[] {
  const { approval, signal, caller, taskContext } = config;
  const timeoutMs = options.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;

  return tools.map((tool) => {
    // `description` and `schema` are protected on Tool; getPrompt is the public
    // read path for exactly this triple, so nothing here reaches into internals.
    const prompt = tool.getPrompt();
    const localName = namespaceMcpTool(options.server, prompt.name);
    const source: ToolSource = {
      kind: 'mcp',
      server: options.server,
      remoteName: prompt.name,
    };

    const spec: ToolSpec = {
      name: localName,
      description: `[via ${options.server} MCP server] ${prompt.description}`,
      inputSchema: prompt.input_schema as unknown as Record<string, unknown>,
      execute: async (input) => {
        if (signal?.aborted) return 'Task interrupted — the tool was not called.';
        try {
          const result = await callWithTimeout(tool, prompt.name, input, timeoutMs, signal);
          return stringifyResult(result);
        } catch (err) {
          // Never rethrow. The model can react to a described failure; it cannot
          // react to an exception that ends the turn.
          const message = err instanceof Error ? err.message : String(err);
          return `MCP tool "${prompt.name}" on server "${options.server}" failed: ${message}`;
        }
      },
    };

    return withApproval(
      spec,
      approval,
      (input) => ({
        toolName: localName,
        description: `Call ${prompt.name} on the ${options.server} MCP server`,
        detail: `${options.server} → ${prompt.name}\n\n${JSON.stringify(input, null, 2)}`,
        source,
      }),
      signal,
      caller,
      taskContext,
    );
  });
}

/**
 * Race the call against a timeout and the task signal.
 *
 * The underlying call keeps running — an MCP request cannot be recalled — but
 * the turn stops waiting on it, which is the difference between Esc working and
 * Esc doing nothing.
 */
async function callWithTimeout(
  tool: Tool<unknown>,
  remoteName: string,
  input: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;

  try {
    return await Promise.race([
      // The agent identity is placeholder: these inner tools are not in the belt
      // the engine attaches listeners to, so their events go nowhere by design —
      // the wrapper is what the transcript observes.
      tool.execute('marshall', 'marshall', input, `mcp-${remoteName}`),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${(timeoutMs / 1000).toFixed(0)}s`)),
          timeoutMs,
        );
        if (signal) {
          onAbort = () => reject(new Error('the task was interrupted'));
          signal.addEventListener('abort', onAbort, { once: true });
        }
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Flatten whatever an MCP tool returned into a string.
 *
 * MCPClient hands back a string for text content but the raw object for
 * `structuredContent`, so this is the difference between the model reading a
 * result and reading "[object Object]".
 */
export function stringifyResult(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result === null || result === undefined) return '(no result)';
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}
