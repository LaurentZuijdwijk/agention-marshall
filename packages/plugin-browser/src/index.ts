#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { generateToken } from './token.js';
import { startServer } from './http-server.js';
import { DEFAULT_PORT } from './constants.js';

function parsePort(): number {
  const fromArg = process.argv.find(a => a.startsWith('--port='))?.split('=')[1];
  const raw = fromArg ?? process.env.MARSHALL_BROWSER_PORT;
  if (!raw) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`invalid port "${raw}" — expected a positive integer`);
  }
  return port;
}

async function main(): Promise<void> {
  // MARSHALL_BROWSER_TOKEN set means a launcher (the Marshall CLI's plugin
  // lifecycle) started this process and already knows the token — the
  // pairing instructions below are for a human watching a standalone run,
  // and printing them here too would be a fresh token's worth of confusion
  // for someone who's already paired.
  const managed = Boolean(process.env.MARSHALL_BROWSER_TOKEN);
  const token = process.env.MARSHALL_BROWSER_TOKEN || generateToken();
  const server = await startServer({ port: parsePort(), token });

  process.stdout.write(managed
    ? `marshall-plugin-browser is running (managed), MCP endpoint: ${server.url}\n`
    : [
      '',
      'marshall-plugin-browser is running.',
      '',
      `  MCP endpoint:  ${server.url}`,
      `  Pairing token: ${token}`,
      '',
      '1. Add this to .marshall/config.json\'s "mcpServers":',
      `     { "name": "browser", "url": "${server.url}" }`,
      '2. Load the extension in Chrome (chrome://extensions, "Load unpacked",',
      '   pick packages/browser-extension/dist), open its options page, and',
      '   paste the pairing token above.',
      '',
      'Ctrl-C to stop.',
      '',
    ].join('\n'));

  const shutdown = async (): Promise<void> => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
}

// Guard against running as a side effect of being imported — `constants.ts`
// exists precisely so nothing needs to import this module for a value, but
// this stays as defense in depth: `main()` binds a real port and can
// `process.exit()`, either of which would be a nasty surprise for a caller
// that only wanted to read something off this module.
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
