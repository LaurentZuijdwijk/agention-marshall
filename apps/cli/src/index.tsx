import { parseArgs } from 'node:util';
import { resolve, dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { config as loadDotenv } from 'dotenv';
import React from 'react';
import { render } from 'ink';
import { App } from './App.js';
import type { AgentProfile, Provider } from '@marshall/engine';
import { PROVIDER_DEFAULTS } from '@marshall/engine';
import { checkForUpdate, currentVersion } from './update-check.js';

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
    provider:         { type: 'string', short: 'p' },
    model:            { type: 'string', short: 'm' },
    'api-key':        { type: 'string' },
    host:             { type: 'string' },
    github:           { type: 'boolean' },
    'no-web-search':  { type: 'boolean' },
    'context-model':  { type: 'string' },
    'planner-model':  { type: 'string' },
    'reviewer-model': { type: 'string' },
    'max-tokens':     { type: 'string' },
    'fast-model':     { type: 'string' },
    'fast-provider':  { type: 'string' },
    'fast-host':      { type: 'string' },
    help:             { type: 'boolean', short: 'h' },
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
  -p, --provider <name>   LLM provider: claude (default), openai, gemini, mistral, ollama, llamacpp, openrouter
  -m, --model <id>        Model ID (defaults per provider shown below)
      --api-key <key>     API key (defaults to provider's env var)
      --host <url>        Server base URL for ollama/llamacpp (defaults: :11434 / :8080), or an
                           OpenRouter-compatible gateway override (default: openrouter.ai)
      --max-tokens <n>    Max output tokens per response (default: 8192; llamacpp default: 32768)

  Model tiers — the deep model writes code, plans and reviews; the fast model
  reads files, searches and summarises on its behalf.
      --fast-model <id>      Model for the fast tier (enables tiering)
      --fast-provider <name> Provider for the fast tier (default: same as deep)
      --fast-host <url>      Server URL for the fast tier (default: same as deep)
      --context-model <id>  Model for the \`context\` tool (fast reader/summarizer), same provider
      --planner-model <id>   Model for /plan and the \`planner\` tool, same provider
      --reviewer-model <id>  Model for /review and the \`reviewer\` tool, same provider
      --github            Enable GitHub tools (requires gh CLI)
      --no-web-search     Disable web search (on by default for the claude provider)
  -h, --help              Show this help

Provider defaults:
${Object.entries(PROVIDER_DEFAULTS)
  .map(([p, d]) => `  ${p.padEnd(10)} ${d.model}  (${d.envKey ?? 'no key needed'})`)
  .join('\n')}

Examples:
  marshall .
  marshall --provider openai --model gpt-4o .
  marshall --provider ollama --model codellama .
  marshall --provider llamacpp --host http://192.168.1.248:8080 .
  marshall --provider openrouter --model moonshotai/kimi-k3 \\
           --fast-provider llamacpp --fast-host http://192.168.1.248:8080 --fast-model Gemma-4-E4B-MTP .
  marshall --provider openrouter --model anthropic/claude-sonnet-4.6 .
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

// Load saved config from .marshall/config.json (overridden by CLI flags).
// The flat provider/model/host keys are the pre-tier format and are still read
// as the deep tier, so existing workspaces keep working untouched.
interface SavedProfile { provider?: string; model?: string; host?: string; apiKey?: string }
interface SavedConfig extends SavedProfile {
  models?: { deep?: SavedProfile; fast?: SavedProfile };
}
let savedConfig: SavedConfig = {};
const savedConfigPath = join(workspaceRoot, '.marshall', 'config.json');
if (existsSync(savedConfigPath)) {
  try { savedConfig = JSON.parse(readFileSync(savedConfigPath, 'utf8')); } catch { /* ignore */ }
}

const savedDeep = savedConfig.models?.deep ?? savedConfig;

const provider = (values.provider as Provider | undefined)
  ?? (savedDeep.provider as Provider | undefined)
  ?? 'claude';

if (!Object.keys(PROVIDER_DEFAULTS).includes(provider)) {
  console.error(`Unknown provider "${provider}". Valid: ${Object.keys(PROVIDER_DEFAULTS).join(', ')}`);
  process.exit(1);
}

// model is undefined when not given via CLI and not in saved config
// → triggers the setup selector in the App
const model = (values.model as string | undefined) ?? savedDeep.model;

const agentProfile: AgentProfile = {
  provider,
  model,
  apiKey: (values['api-key'] as string | undefined) ?? savedDeep.apiKey,
  host:   (values.host as string | undefined) ?? savedDeep.host,
};

// ── fast tier ────────────────────────────────────────────────────────────────
// Defaults to the deep tier's provider/host, since the common case is a smaller
// model on the same server — but each flag can be set independently so the two
// tiers can sit on entirely different providers (e.g. hosted deep, local fast).
const savedFast = savedConfig.models?.fast;
const fastProvider = (values['fast-provider'] as Provider | undefined)
  ?? (savedFast?.provider as Provider | undefined)
  ?? provider;
const fastModel = (values['fast-model'] as string | undefined) ?? savedFast?.model;

if (fastProvider && !Object.keys(PROVIDER_DEFAULTS).includes(fastProvider)) {
  console.error(`Unknown fast provider "${fastProvider}". Valid: ${Object.keys(PROVIDER_DEFAULTS).join(', ')}`);
  process.exit(1);
}

const fastProfile: AgentProfile | undefined = fastModel
  ? {
      provider: fastProvider,
      model: fastModel,
      // Only inherit the key when the tiers share a provider — a local fast tier
      // must not be handed a hosted provider's credentials.
      apiKey: fastProvider === provider
        ? ((values['api-key'] as string | undefined) ?? savedDeep.apiKey)
        : savedFast?.apiKey,
      host: (values['fast-host'] as string | undefined)
        ?? savedFast?.host
        ?? (fastProvider === provider ? agentProfile.host : undefined),
    }
  : undefined;

const enableGitHub = Boolean(values.github);
const enableWebSearch = !values['no-web-search'];

const DEFAULT_MAX_TOKENS_BY_PROVIDER: Partial<Record<Provider, number>> = {
  llamacpp: 32768,
  ollama:   32768,
};
const maxTokens = values['max-tokens']
  ? parseInt(values['max-tokens'] as string, 10)
  : (DEFAULT_MAX_TOKENS_BY_PROVIDER[provider] ?? undefined);

// Role overrides (context/planner/reviewer) reuse the main provider+key+host, just a different model.
const roleProfile = (roleModel: string | undefined): AgentProfile | undefined =>
  roleModel
    ? { provider, model: roleModel, apiKey: values['api-key'] as string | undefined, host: agentProfile.host }
    : undefined;

const contextAgentProfile = roleProfile(values['context-model'] as string | undefined);
const plannerAgentProfile = roleProfile(values['planner-model'] as string | undefined);
const reviewerAgentProfile = roleProfile(values['reviewer-model'] as string | undefined);

const updatePromise = checkForUpdate();

const { waitUntilExit } = render(
  <App
    workspaceRoot={workspaceRoot}
    agentProfile={agentProfile}
    fastProfile={fastProfile}
    contextAgentProfile={contextAgentProfile}
    plannerAgentProfile={plannerAgentProfile}
    reviewerAgentProfile={reviewerAgentProfile}
    enableGitHub={enableGitHub}
    enableWebSearch={enableWebSearch}
    maxTokens={maxTokens}
  />,
  // The App owns Ctrl-C so it can interrupt a running task before quitting;
  // ink's built-in handler would unmount without cancelling anything.
  { exitOnCtrlC: false },
);

await waitUntilExit();

// Show update notice after the TUI exits so it doesn't interfere with rendering.
const notice = await Promise.race([
  updatePromise,
  new Promise<null>(r => setTimeout(() => r(null), 500)),
]);
if (notice) process.stderr.write(`\n${notice}\n`);

// Leave explicitly. An aborted LLM request or the update check above can leave
// a socket pending, and node would sit there indefinitely with the UI already
// torn down. Everything we needed to write has been written by this point.
process.exit(0);
