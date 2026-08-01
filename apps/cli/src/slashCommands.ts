// ── slash command parsing (pure logic, testable) ────────────────────────────────

export const SLASH_COMMANDS = ['/clear', '/cwd', '/exit', '/help', '/login', '/memory', '/model', '/plan', '/review', '/stream', '/tokens'] as const;

export type SlashCommandResult =
  | { type: 'unknown'; command: string }
  | { type: 'help' }
  | { type: 'exit' }
  | { type: 'model' }
  | { type: 'cwd' }
  | { type: 'memory' }
  | { type: 'login' }
  | { type: 'clear' }
  | { type: 'stream' }
  | { type: 'tokens' }
  | { type: 'plan'; args: string }
  | { type: 'review'; args: string };

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
    case '/model': return { type: 'model' };
    case '/cwd':   return { type: 'cwd' };
    case '/memory': return { type: 'memory' };
    case '/login': return { type: 'login' };
    case '/clear': return { type: 'clear' };
    case '/stream': return { type: 'stream' };
    case '/tokens': return { type: 'tokens' };
    case '/plan':   return { type: 'plan', args };
    case '/review': return { type: 'review', args };
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
  /clear             — clear history, dedupe cache, and scratch notes
  /tokens            — toggle token usage (↑ in / ↓ out / time) after each response
  /stream            — toggle streaming tokens live vs showing the final response only
  /cwd               — show workspace path
  /memory            — view AGENTS.md (project memory)
  /exit              — quit

Esc              — interrupt running task (enters steering mode)
Ctrl-R           — toggle live reasoning (providers that stream chain-of-thought)
Esc Esc          — force-quit
Esc (approval)   — deny all pending and interrupt
Ctrl-C           — interrupt, or quit when nothing is running
Ctrl-C Ctrl-C    — force-quit`;
