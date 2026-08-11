// ── command line ──────────────────────────────────────────────────────────────
//
// The flag table and the help text live together on purpose: they drifted apart
// once already, and a flag the help doesn't mention may as well not exist.
//
// `parseArgs` hands back `string | boolean | (string | boolean)[]` for every
// value, so the raw result is cast exactly once — here — into `CliFlags`. The
// rest of startup then reads plain optional strings.

import { parseArgs } from 'node:util';
import { PROVIDER_DEFAULTS } from '@agentionai/marshall-engine';

const OPTIONS = {
  provider:         { type: 'string',  short: 'p' },
  model:            { type: 'string',  short: 'm' },
  'api-key':        { type: 'string'  },
  host:             { type: 'string'  },
  github:           { type: 'boolean' },
  'no-web-search':  { type: 'boolean' },
  light:            { type: 'boolean' },
  'context-model':  { type: 'string'  },
  'planner-model':  { type: 'string'  },
  'reviewer-model': { type: 'string'  },
  'max-tokens':     { type: 'string'  },
  'reasoning-effort': { type: 'string' },
  'fast-model':     { type: 'string'  },
  'fast-provider':  { type: 'string'  },
  'fast-host':      { type: 'string'  },
  help:             { type: 'boolean', short: 'h' },
} as const;

export interface CliFlags {
  /** Positional workspace path, if given. */
  workspace?: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  host?: string;
  maxTokens?: string;
  reasoningEffort?: string;
  fastProvider?: string;
  fastModel?: string;
  fastHost?: string;
  contextModel?: string;
  plannerModel?: string;
  reviewerModel?: string;
  github: boolean;
  webSearch: boolean;
  /** Undefined means "not asked for on the CLI" — the config still gets a say. */
  light?: boolean;
  help: boolean;
}

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

export function parseCliArgs(argv: string[] = process.argv.slice(2)): CliFlags {
  // Non-strict so an unrecognised flag prints help instead of throwing a stack
  // trace at someone who mistyped one.
  const { values, positionals } = parseArgs({
    args: argv,
    options: OPTIONS,
    allowPositionals: true,
    strict: false,
  });

  return {
    workspace:      positionals[0],
    provider:       str(values.provider),
    model:          str(values.model),
    apiKey:         str(values['api-key']),
    host:           str(values.host),
    maxTokens:      str(values['max-tokens']),
    reasoningEffort: str(values['reasoning-effort']),
    fastProvider:   str(values['fast-provider']),
    fastModel:      str(values['fast-model']),
    fastHost:       str(values['fast-host']),
    contextModel:   str(values['context-model']),
    plannerModel:   str(values['planner-model']),
    reviewerModel:  str(values['reviewer-model']),
    github:         values.github === true,
    light:          values.light === true ? true : undefined,
    webSearch:      values['no-web-search'] !== true,
    help:           values.help === true,
  };
}

export function helpText(): string {
  return `
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
      --light             Lean belt for small models: no scratchpad, background jobs or
                           sub-agents, and a prompt with only the rules that still apply
                           (~1100 fewer tokens per request). Also /runtime light in the
                           session, which saves it for next time
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
`.trim();
}
