// A real, minimal "server-backed plugin" for tests to point PluginRegistry
// (or a whole Session) at — a genuine child process with a genuine MCP
// endpoint, not a mock of either. Shared by plugins.test.ts and the
// integration test that proves a Session auto-enables a configured plugin.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';

/**
 * An OS-assigned free port, not an incrementing counter — Node's test runner
 * runs different test *files* as separate processes, so a plain in-module
 * counter starting at the same number in each process let two files pick the
 * identical "next" port and collide, which surfaced as an intermittent
 * "fetch failed" exactly once in a while during development. The residual
 * race here (something else grabbing the port in the gap between this
 * closing and the fixture's own `app.listen()`) is far narrower.
 */
function reserveFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

export interface FixturePlugin {
  descriptorUrl: string;
  dir: string;
  port: number;
  cleanup(): void;
}

/**
 * Writes server.mjs (a real MCP server with one `ping` tool, GET /health)
 * and descriptor.mjs (its `marshallPlugin` export) to a temp dir *inside*
 * this package — a bare specifier like '@modelcontextprotocol/sdk' resolves
 * by walking up from the importing file's own location, and the system
 * tmpdir has no path back to this monorepo's node_modules at all.
 */
export async function writeFixturePlugin(opts: { name?: string; failHealth?: boolean } = {}): Promise<FixturePlugin> {
  const name = opts.name ?? 'fixture';
  const dir = mkdtempSync(join(process.cwd(), '.tmp-plugin-fixture-'));
  const port = await reserveFreePort();

  writeFileSync(join(dir, 'server.mjs'), `
import { writeFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';

writeFileSync(${JSON.stringify(join(dir, 'pid.txt'))}, String(process.pid));
writeFileSync(${JSON.stringify(join(dir, 'token.txt'))}, process.env.FIXTURE_TOKEN ?? '');

const port = ${port};
const failHealth = ${opts.failHealth ? 'true' : 'false'};

function buildServer() {
  const s = new McpServer({ name: ${JSON.stringify(name)}, version: '1.0.0' });
  s.registerTool('ping', { description: 'ping', inputSchema: {} }, async () => ({
    content: [{ type: 'text', text: 'pong' }],
  }));
  return s;
}

const app = createMcpExpressApp();
app.post('/mcp', async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const mcpServer = buildServer();
  res.on('close', () => { transport.close(); mcpServer.close(); });
  await mcpServer.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
app.get('/health', (_req, res) => {
  if (failHealth) { res.writeHead(500).end(); return; }
  res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
});
app.listen(port, '127.0.0.1');
`);

  writeFileSync(join(dir, 'descriptor.mjs'), `
export const marshallPlugin = {
  name: ${JSON.stringify(name)},
  defaultPort: ${port},
  resolveEntryPath: () => ${JSON.stringify(join(dir, 'server.mjs'))},
  buildLaunch: ({ token }) => ({ args: [], env: { FIXTURE_TOKEN: token } }),
  healthPath: '/health',
  mcpPath: '/mcp',
};
`);

  return {
    descriptorUrl: pathToFileURL(join(dir, 'descriptor.mjs')).href,
    dir,
    port,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
