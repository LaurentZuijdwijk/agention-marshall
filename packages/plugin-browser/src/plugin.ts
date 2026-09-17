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

export function extensionSetupInstructions({ port = DEFAULT_PORT, paired = false } = {}): string {
  return [
    `Install the browser extension (guided setup): http://127.0.0.1:${port}/setup`,
    'Website download: https://marshall.agention.ai/docs.html#browser-extension',
    `Direct ZIP download (bundled version): http://127.0.0.1:${port}/extension.zip — keep Marshall running.`,
    'Extract the ZIP into a permanent folder, open chrome://extensions (Edge: edge://extensions), enable Developer mode, then Load unpacked → the folder containing manifest.json.',
    // A token is printed once, when it is generated. Re-enabling a plugin that
    // already has one prints nothing, so telling that user to paste the token
    // sends them looking for a value they were never shown.
    paired
      ? `Pin the extension and open its popup — an extension paired earlier keeps its token, so there is nothing to paste. Advanced: bridge URL = ws://127.0.0.1:${port}/bridge`
      : `Pin the extension, open its popup, paste the pairing token, and click Save & connect. Advanced: bridge URL = ws://127.0.0.1:${port}/bridge`,
    'Already installed? No reinstall needed — check the popup says connected.',
  ].join('\n');
}
