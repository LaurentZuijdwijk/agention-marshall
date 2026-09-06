import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT } from './constants.js';

/**
 * The contract `packages/engine/src/plugins.ts`'s `PluginRegistry` checks for
 * (structurally, via `import()` — the engine never imports this package at
 * compile time, so this type is not shared, just mirrored). Exported from
 * `@agentionai/marshall-plugin-browser/plugin` rather than the package root:
 * the root export is the server's own runtime pieces (`startServer`,
 * `ExtensionBridge`, …), and a plugin loader has no business pulling those
 * in — it only ever needs this one small, static description of how to
 * launch and reach the server.
 */
export interface MarshallServerPlugin {
  name: string;
  defaultPort: number;
  resolveEntryPath(): string;
  buildLaunch(opts: { port: number; token: string }): { args: string[]; env: Record<string, string> };
  healthPath: string;
  mcpPath: string;
}

export const marshallPlugin: MarshallServerPlugin = {
  name: 'browser',
  defaultPort: DEFAULT_PORT,
  resolveEntryPath: () => fileURLToPath(new URL('./index.js', import.meta.url)),
  buildLaunch: ({ port, token }) => ({
    args: [`--port=${port}`],
    env: { MARSHALL_BROWSER_TOKEN: token },
  }),
  healthPath: '/health',
  mcpPath: '/mcp',
};
