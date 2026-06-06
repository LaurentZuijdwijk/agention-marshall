import { parseArgs } from 'node:util';
import { resolve, dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { config as loadDotenv } from 'dotenv';
import React from 'react';
import { render } from 'ink';
import { App } from './App.js';
import type { AgentProfile, Provider } from '@marshall/engine';
import { PROVIDER_DEFAULTS } from '@marshall/engine';

function findGitRoot(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Parse args first (positionals[0] may be the workspace with its own .env)
const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    provider: { type: 'string', short: 'p' },
    model:    { type: 'string', short: 'm' },
    'api-key':{ type: 'string' },
    host:     { type: 'string' },
    github:   { type: 'boolean' },
    help:     { type: 'boolean', short: 'h' },
  },
  allowPositionals: true,
  strict: false,
});

if (values.help) {
  console.log(`
marshall — coding assistant

Usage:
  marshall [options] [workspace]

Options:
  -p, --provider <name>   LLM provider: claude (default), openai, gemini, mistral, ollama
  -m, --model <id>        Model ID (defaults per provider shown below)
      --api-key <key>     API key (defaults to provider's env var)
      --host <url>        Ollama host (default: http://localhost:11434)
      --github            Enable GitHub tools (requires gh CLI)
  -h, --help              Show this help

Provider defaults:
${Object.entries(PROVIDER_DEFAULTS)
  .map(([p, d]) => `  ${p.padEnd(10)} ${d.model}  (${d.envKey ?? 'no key needed'})`)
  .join('\n')}

Examples:
  marshall .
  marshall --provider openai --model gpt-4o .
  marshall --provider ollama --model codellama .
  marshall --provider claude --model claude-opus-4-6 /path/to/project
`.trim());
  process.exit(0);
}

const workspaceRoot = resolve(positionals[0] ?? findGitRoot(process.cwd()) ?? process.cwd());

// Load .env files — workspace dir first, then walk up from cwd to the git
// root so monorepo setups work regardless of which directory npm runs from.
// override: false means shell env vars always win over .env values.
{
  const seen = new Set<string>();
  const load = (dir: string) => {
    const p = join(resolve(dir), '.env');
    if (!seen.has(p)) { seen.add(p); loadDotenv({ path: p, override: false }); }
  };

  load(workspaceRoot);

  let dir = process.cwd();
  while (true) {
    load(dir);
    if (existsSync(join(dir, '.git'))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

const provider = (values.provider as Provider | undefined) ?? 'claude';

if (!Object.keys(PROVIDER_DEFAULTS).includes(provider)) {
  console.error(`Unknown provider "${provider}". Valid: ${Object.keys(PROVIDER_DEFAULTS).join(', ')}`);
  process.exit(1);
}

const agentProfile: AgentProfile = {
  provider,
  model:  values.model as string | undefined,
  apiKey: values['api-key'] as string | undefined,
  host:   values.host as string | undefined,
};

const enableGitHub = Boolean(values.github);

render(
  <App
    workspaceRoot={workspaceRoot}
    agentProfile={agentProfile}
    enableGitHub={enableGitHub}
  />,
);
