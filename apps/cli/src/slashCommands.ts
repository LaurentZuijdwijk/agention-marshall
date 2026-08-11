// ── slash command parsing (pure logic, testable) ────────────────────────────────

import type { RuntimeMode, SettingsScope } from './services/settings.js';

// `/runtime` rather than `/mode`: a command name that is a strict prefix of
// another one ("/mode" of "/model") makes tab completion actively wrong — the
// complete, valid command silently grows into a different one.
export const SLASH_COMMANDS = ['/clear', '/cwd', '/exit', '/goal', '/help', '/jobs', '/login', '/mcp', '/memory', '/model', '/plan', '/review', '/runtime', '/safety', '/stream', '/tokens', '/update', '/version'] as const;

/** Which tier `/model` is about to change. `both` is the first-run chain. */
export type ModelTarget = 'both' | 'deep' | 'fast' | 'off';

/**
 * The tool-call approval gate, named rather than numbered on the CLI surface —
 * `EngineConfig.safetyLevel` is still `1 | 2 | 3` underneath (see config.ts),
 * but "agentic" reads at a glance where "3" doesn't. Level 1 is `yolo` on
 * purpose: the word should feel reckless, because the mode is.
 */
export type SafetyLevelWord = 'yolo' | 'default' | 'agentic';

export const SAFETY_LEVEL_WORDS: Record<SafetyLevelWord, { level: 1 | 2 | 3; blurb: string }> = {
  yolo: {
    level: 1,
    blurb: 'no approval gate at all — every tool call runs immediately (dangerous; for a sandboxed/CI setting only)',
  },
  default: {
    level: 2,
    blurb: 'you approve every state-changing tool call (the default)',
  },
  agentic: {
    level: 3,
    blurb: 'a judge model reviews each call first — a clear "safe" verdict skips you, an "unsafe" one still asks you, with the model\'s reasoning attached',
  },
};

export const SAFETY_LEVEL_LABELS: Record<1 | 2 | 3, SafetyLevelWord> = { 1: 'yolo', 2: 'default', 3: 'agentic' };

export type SlashCommandResult =
  | { type: 'unknown'; command: string }
  /** Recognised, but used wrongly — the message tells the user how. */
  | { type: 'usage'; message: string }
  | { type: 'help' }
  | { type: 'exit' }
  | { type: 'model'; target: ModelTarget }
  | { type: 'cwd' }
  | { type: 'memory' }
  | { type: 'login' }
  | { type: 'clear' }
  | { type: 'stream' }
  /** No `mode` means "show the current one". `scope` is where a change is saved. */
  | { type: 'runtime'; mode?: RuntimeMode; scope: SettingsScope }
  | { type: 'tokens' }
  | { type: 'update' }
  | { type: 'version' }
  | { type: 'plan'; args: string }
  | { type: 'goal'; args: string }
  | { type: 'review'; args: string }
  /** No `level` means "show the current level and what each does". */
  | { type: 'safety'; level?: SafetyLevelWord }
  /** `/jobs` lists; `/jobs kill <id>` (or `kill all`) stops. */
  | { type: 'jobs'; kill?: string }
  /** `/mcp` lists; `add` opens the wizard; `remove`/`reconnect` name a server.
   *  One member per action rather than a combined `'list' | 'add'`, so that
   *  ruling those out actually narrows to the member carrying `server`. */
  | { type: 'mcp'; action: 'list' }
  | { type: 'mcp'; action: 'add' }
  | { type: 'mcp'; action: 'remove' | 'reconnect'; server: string };

const MODEL_TARGETS: Record<string, ModelTarget> = {
  '': 'both', deep: 'deep', fast: 'fast', off: 'off',
};

export interface SubcommandWord {
  word: string;
  /**
   * Present when the word is a verb that still needs a value — a job id, a
   * server name. Completing one of these leaves a trailing space, because the
   * command is not runnable yet; the rest is only known at runtime, so there is
   * nothing further to offer.
   */
  operand?: string;
}

/**
 * The argument words each command takes, in the order they are offered.
 *
 * Kept beside the parser deliberately. These are the same words
 * `resolveSlashCommand` accepts, and a completion list that drifts from what
 * the parser takes is worse than no completion at all — it offers something
 * that then fails. There is a test pinning the two together.
 */
export const SUBCOMMANDS: Record<string, readonly SubcommandWord[]> = {
  '/model': [{ word: 'deep' }, { word: 'fast' }, { word: 'off' }],
  '/runtime': [{ word: 'default' }, { word: 'light' }, { word: 'agentic' }],
  '/safety': [{ word: 'default' }, { word: 'yolo' }, { word: 'agentic' }],
  '/jobs': [{ word: 'kill', operand: '<id>' }],
  '/mcp': [{ word: 'add' }, { word: 'remove', operand: '<name>' }, { word: 'reconnect', operand: '<name>' }],
};

/**
 * The suffix tab would append to `input`, or '' when there is nothing to add.
 *
 * Completes the command name before a space, and the first argument word after
 * one — so `/model` fills in from `/mod`, and `/model ` offers `deep`. First
 * match wins rather than the longest common prefix, which is what the command
 * names already did.
 */
export function completeSlash(input: string): string {
  if (!input.startsWith('/')) return '';

  const spaceAt = input.indexOf(' ');
  if (spaceAt === -1) {
    if (input.length < 2) return '';
    const match = SLASH_COMMANDS.find(cmd => cmd.startsWith(input) && cmd !== input);
    return match ? match.slice(input.length) : '';
  }

  const rest = input.slice(spaceAt + 1);
  // Past the first argument there is nothing static left to offer — the second
  // word is always a job id or a server name.
  if (rest.includes(' ')) return '';

  const options = SUBCOMMANDS[input.slice(0, spaceAt)];
  const match = options?.find(({ word }) => word.startsWith(rest) && word !== rest);
  if (!match) return '';
  // A verb that still needs a value gets the space too, so accepting the
  // completion leaves the cursor where the id or name goes.
  return match.word.slice(rest.length) + (match.operand ? ' ' : '');
}

export function resolveSlashCommand(input: string): SlashCommandResult {
  const text = input.trim();
  if (!text.startsWith('/')) return { type: 'unknown', command: text };

  const cmd = text.split(' ')[0];
  const known = SLASH_COMMANDS.find(c => c === cmd);
  if (!known) return { type: 'unknown', command: cmd };
  const args = text.slice(cmd.length).trim();

  switch (known) {
    case '/help':  return { type: 'help' };
    case '/exit':  return { type: 'exit' };
    case '/model': {
      const target = MODEL_TARGETS[args.toLowerCase()];
      return target
        ? { type: 'model', target }
        : { type: 'usage', message: `usage: /model [deep|fast|off] — got "${args}"` };
    }
    case '/cwd':   return { type: 'cwd' };
    case '/memory': return { type: 'memory' };
    case '/login': return { type: 'login' };
    case '/clear': return { type: 'clear' };
    case '/stream': return { type: 'stream' };
    case '/runtime': {
      const usage = `usage: /runtime [default|light|agentic] [--global] — got "${args}"`;
      // `--global` is picked out wherever it sits, so neither word order is a
      // usage error someone has to look up.
      const words = args.toLowerCase().split(/\s+/).filter(Boolean);
      const scope: SettingsScope = words.includes('--global') ? 'global' : 'project';
      const rest = words.filter(word => word !== '--global');
      if (rest.length === 0) {
        // Asking to save nothing globally is a typo, not a query — reporting the
        // current mode would look like the flag had been accepted.
        return scope === 'global'
          ? { type: 'usage', message: usage }
          : { type: 'runtime', mode: undefined, scope };
      }
      if (rest.length > 1) return { type: 'usage', message: usage };
      const mode = rest[0];
      return mode === 'default' || mode === 'light' || mode === 'agentic'
        ? { type: 'runtime', mode, scope }
        : { type: 'usage', message: usage };
    }
    case '/tokens': return { type: 'tokens' };
    case '/update': return args
      ? { type: 'usage', message: `usage: /update — got "${args}"` }
      : { type: 'update' };
    case '/version': return args
      ? { type: 'usage', message: `usage: /version — got "${args}"` }
      : { type: 'version' };
    case '/plan':
      return args
        ? { type: 'plan', args }
        : { type: 'usage', message: 'usage: /plan <task> — describe what you want planned' };
    case '/goal':
      return args
        ? { type: 'goal', args }
        : { type: 'usage', message: 'usage: /goal <task> — describe what you want to achieve' };
    case '/review': return { type: 'review', args };
    case '/safety': {
      if (!args) return { type: 'safety', level: undefined };
      const word = args.toLowerCase();
      return word in SAFETY_LEVEL_WORDS
        ? { type: 'safety', level: word as SafetyLevelWord }
        : { type: 'usage', message: `usage: /safety [yolo|default|agentic] — got "${args}"` };
    }
    case '/mcp': {
      if (!args) return { type: 'mcp', action: 'list' };
      const [verb, server] = args.split(/\s+/);
      if (verb === 'add') return { type: 'mcp', action: 'add' };
      if ((verb === 'remove' || verb === 'reconnect') && server) {
        return { type: 'mcp', action: verb, server };
      }
      return {
        type: 'usage',
        message: `usage: /mcp [add|remove <name>|reconnect <name>] — got "${args}"`,
      };
    }

    case '/jobs': {
      if (!args) return { type: 'jobs' };
      const [verb, id] = args.split(/\s+/);
      if (verb !== 'kill' || !id) {
        return { type: 'usage', message: `usage: /jobs [kill <id>|kill all] — got "${args}"` };
      }
      return { type: 'jobs', kill: id };
    }
  }
}

export const HELP = `commands:
  /help              — show this message
  /login             — authenticate with your Claude account
  /model             — pick both models (deep, then fast)
  /model deep        — change the model that writes code, plans and reviews
  /model fast        — change the model that reads files and summarises for it
  /model off         — stop tiering; run everything on the deep model
  /plan <task>       — get a plan before making changes (used as context for your next task)
  /goal <task>       — clarify what "done" looks like before making changes (used as context for your next task)
  /review [notes]    — get a second opinion on the current workspace state
  /safety            — show the current tool-call safety level and what each does
  /safety yolo       — no approval gate at all (dangerous)
  /safety default    — you approve every state-changing tool call (the default)
  /safety agentic    — a judge model reviews each call first; choose it after this
  /jobs              — list background shell jobs from this session
  /jobs kill <id>    — stop one background job, or "all" for every one
  /mcp               — list MCP servers and the tools they offer
  /mcp add           — connect a new MCP server over http
  /mcp remove <name> — disconnect and forget a server
  /mcp reconnect <n> — retry a server that failed
  /clear             — clear history, dedupe cache, and scratch notes
  /tokens            — what this session has spent, per agent and model
  /stream            — toggle streaming tokens live vs showing the final response only
  /runtime           — show the current runtime mode
  /runtime default   — use the full tool belt
  /runtime light     — use the lean tool belt for small models (no scratchpad,
                       background jobs or sub-agents; ~1100 fewer tokens per request)
  /runtime agentic   — use agentic behaviour (coming soon)
  /runtime <mode> --global
                     — save it for every workspace, not just this one
  /version           — show the installed version
  /update            — check for and install the latest version
  /cwd               — show workspace path
  /memory            — view AGENTS.md (project memory)
  /exit              — quit

Esc              — interrupt running task (enters steering mode)
Ctrl-R           — toggle live reasoning (providers that stream chain-of-thought)
Ctrl-V           — attach the image on your clipboard to the next message
Esc Esc          — force-quit
Esc (approval)   — deny all pending and interrupt
Ctrl-C           — interrupt, or quit when nothing is running
Ctrl-C Ctrl-C    — force-quit`;
