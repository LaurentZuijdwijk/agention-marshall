import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ExtensionBridge } from './bridge.js';
import { extensionSetupPage } from './extension-setup.js';
import { registerBrowserTools } from './tools.js';

export interface StartOptions {
  /** 0 picks an ephemeral port — used by tests. */
  port?: number;
  token: string;
}

export interface RunningServer {
  /** The MCP endpoint — what goes in `.marshall/config.json`'s `mcpServers`. */
  url: string;
  /** The extension's connection target, minus the `?token=` — see index.ts. */
  bridgeUrl: string;
  port: number;
  bridge: ExtensionBridge;
  close: () => Promise<void>;
}

function buildMcpServer(bridge: ExtensionBridge): McpServer {
  const server = new McpServer({ name: 'marshall-browser', version: '0.1.0' });
  registerBrowserTools(server, bridge);
  return server;
}

/**
 * One HTTP server, two mounts: `/mcp` (Streamable HTTP, stateless — what
 * `MCPClient.fromUrl` in the engine talks to) and `/bridge` (WebSocket
 * upgrade — what the extension talks to). Binds to 127.0.0.1 only; this is a
 * local trust boundary, not a service meant to be reachable from anywhere
 * else on the network.
 *
 * Stateless mode gets a fresh `McpServer`/`StreamableHTTPServerTransport`
 * pair per request rather than one long-lived pair: reusing a single
 * transport instance across independent HTTP requests answers the second
 * request (the `notifications/initialized` that follows every
 * `initialize`) with an empty 500 — confirmed by hand, and consistent with
 * every stateless example in the SDK creating its pair per request.
 */
export async function startServer(options: StartOptions): Promise<RunningServer> {
  const bridge = new ExtensionBridge(options.token);
  const app = createMcpExpressApp({ host: '127.0.0.1' });

  app.post('/mcp', async (req: IncomingMessage & { body?: unknown }, res: ServerResponse) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const mcpServer = buildMcpServer(bridge);
    res.on('close', () => { transport.close(); mcpServer.close(); });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get('/setup', (_req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    res.setHeader('x-content-type-options', 'nosniff');
    res.end(extensionSetupPage(port));
  });

  // Public, static extension assets only: no pairing token is embedded in the ZIP.
  app.get('/extension.zip', async (_req: IncomingMessage, res: ServerResponse) => {
    try {
      const zip = await readFile(new URL('../dist/marshall-browser-extension.zip', import.meta.url));
      res.setHeader('content-type', 'application/zip');
      res.setHeader('content-disposition', 'attachment; filename="marshall-browser-extension.zip"');
      res.end(zip);
    } catch {
      res.statusCode = 404;
      res.end('Extension ZIP is unavailable. Rebuild or reinstall the browser plugin.');
    }
  });

  app.get('/health', (_req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, plugin: 'marshall-browser-v1', extensionConnected: bridge.connected }));
  });

  const server = app.listen(options.port ?? 0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address() as AddressInfo;

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (new URL(req.url ?? '', 'http://localhost').pathname === '/bridge') {
      bridge.handleUpgrade(req, socket, head);
    } else {
      socket.destroy();
    }
  });

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    bridgeUrl: `ws://127.0.0.1:${port}/bridge`,
    port,
    bridge,
    close: () => new Promise<void>((resolve) => {
      bridge.close();
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
