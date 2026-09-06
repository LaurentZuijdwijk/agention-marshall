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

/**
 * Mime types every provider we talk to accepts as an attached image, and the
 * per-image size ceiling (measured on the decoded bytes, matching how
 * providers publish their own limits). Mirrors
 * `packages/engine/src/images.ts`'s limits for the same reason that file
 * exists — Anthropic is the tightest of the providers, so one number covers
 * all of them — duplicated here rather than imported so this package keeps
 * its only dependency on `@agentionai/agents` and Node built-ins.
 */
export const SUPPORTED_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const MAX_TOOL_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * What `MCPClientOptions.formatResult` returns for a result carrying image
 * content blocks — see `packages/engine/src/mcp.ts`. `adaptMcpTools` is the
 * only place that constructs (via `multimodalMcpResult`) or reads this shape;
 * everything else treats an MCP result as an opaque `unknown`.
 */
export interface McpMultimodalResult {
  readonly __marshallMultimodal: true;
  /** Rendered exactly as the SDK's default text renderer would, minus the image blocks. */
  text: string;
  images: { data: string; mimeType: string }[];
}

export function multimodalMcpResult(
  text: string,
  images: { data: string; mimeType: string }[],
): McpMultimodalResult {
  return { __marshallMultimodal: true, text, images };
}

function isMultimodalResult(value: unknown): value is McpMultimodalResult {
  return typeof value === 'object' && value !== null
    && (value as { __marshallMultimodal?: unknown }).__marshallMultimodal === true;
}

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
  const { approval, signal, caller, taskContext, attachImages } = config;
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
          if (isMultimodalResult(result)) return renderMultimodalResult(result, attachImages);
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
/**
 * Turns a multimodal MCP result into the tool's text return value, pushing
 * whatever images pass the mime/size check through `attachImages` so the
 * belt's owner (the engine, via `History.addMessage`) can put them in front
 * of the model on the next turn.
 *
 * Never drops an image silently: one that fails validation, or a belt with
 * no `attachImages` at all (a sub-agent's belt, today), is named in the text
 * result instead, so the model knows a screenshot existed even when it
 * couldn't see it.
 */
function renderMultimodalResult(
  result: McpMultimodalResult,
  attachImages: ((images: { data: string; mimeType: string }[]) => void) | undefined,
): string {
  if (result.images.length === 0) return result.text;

  const accepted: { data: string; mimeType: string }[] = [];
  const rejected: string[] = [];
  for (const image of result.images) {
    if (!SUPPORTED_IMAGE_MIME_TYPES.includes(image.mimeType)) {
      rejected.push(`unsupported type ${image.mimeType}`);
      continue;
    }
    const bytes = Math.floor(image.data.length * 3 / 4);
    if (bytes > MAX_TOOL_IMAGE_BYTES) {
      rejected.push(`${(bytes / 1024 / 1024).toFixed(1)}MB, over the ${MAX_TOOL_IMAGE_BYTES / 1024 / 1024}MB limit`);
      continue;
    }
    accepted.push(image);
  }

  const notes: string[] = [];
  if (accepted.length > 0 && attachImages) {
    attachImages(accepted);
    notes.push(`(${accepted.length} image${accepted.length === 1 ? '' : 's'} attached above)`);
  } else if (accepted.length > 0) {
    notes.push(`(this tool returned ${accepted.length} image(s), but nothing here can display them)`);
  }
  for (const reason of rejected) notes.push(`(an image was dropped: ${reason})`);

  return [result.text, ...notes].filter(Boolean).join('\n\n');
}

export function stringifyResult(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result === null || result === undefined) return '(no result)';
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}
