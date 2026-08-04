// ── slash command parsing (pure logic, testable) ────────────────────────────────

export const SLASH_COMMANDS = ['/clear', '/cwd', '/exit', '/help', '/jobs', '/login', '/mcp', '/memory', '/model', '/plan', '/review', '/stream', '/tokens'] as const;

/** Which tier `/model` is about to change. `both` is the first-run chain. */
export type ModelTarget = 'both' | 'deep' | 'fast' | 'off';

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
  | { type: 'tokens' }
  | { type: 'plan'; args: string }
  | { type: 'review'; args: string }
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
    case '/tokens': return { type: 'tokens' };
    case '/plan':
      return args
        ? { type: 'plan', args }
        : { type: 'usage', message: 'usage: /plan <task> — describe what you want planned' };
    case '/review': return { type: 'review', args };
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
  /review [notes]    — get a second opinion on the current workspace state
  /jobs              — list background shell jobs from this session
  /jobs kill <id>    — stop one background job, or "all" for every one
  /mcp               — list MCP servers and the tools they offer
  /mcp add           — connect a new MCP server over http
  /mcp remove <name> — disconnect and forget a server
  /mcp reconnect <n> — retry a server that failed
  /clear             — clear history, dedupe cache, and scratch notes
  /tokens            — toggle token usage (↑ in / ↓ out / time) after each response
  /stream            — toggle streaming tokens live vs showing the final response only
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
