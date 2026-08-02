// ── running a slash command ───────────────────────────────────────────────────
//
// The parser (slashCommands.ts) says what was typed; this says what it does.
// Everything it touches arrives in `deps`, so the whole command surface can be
// exercised without React, Ink or a real Session.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentProfile } from '@agentionai/marshall-engine';
import type { Approvals } from './hooks/useApprovals.js';
import type { PreferencesController } from './hooks/usePreferences.js';
import type { Transcript } from './hooks/useTranscript.js';
import type { Message } from './view/message.js';
import type { LoginSession } from './login.js';
import type { SetMode } from './mode.js';
import { resolveSlashCommand, HELP } from './slashCommands.js';

/** The subset of the engine Session the commands need. */
export interface CommandSession {
  plan(task: string): Promise<unknown>;
  review(notes?: string): Promise<unknown>;
  clear(): Promise<string>;
}

export interface CommandDeps {
  workspaceRoot: string;
  transcript: Transcript;
  session: CommandSession | null;
  approvals: Approvals;
  prefs: PreferencesController;
  setMode: SetMode;
  setSteering(steering: boolean): void;
  /** The header row to put back at the top after `/clear`. */
  headerMessage(): Message;
  applyProfiles(deep: AgentProfile, fast: AgentProfile | undefined): void;
  activeProfile: AgentProfile;
  quit(): void;
  startLogin(): LoginSession;
}

export function runSlashCommand(input: string, deps: CommandDeps): void {
  const { transcript, session, setMode } = deps;
  const command = resolveSlashCommand(input);

  /** Both long-running commands report the same way, so they share a path. */
  const start = (echo: string, work: (session: CommandSession) => Promise<unknown>) => {
    if (!session) {
      transcript.push('error', 'no model chosen yet — finish setup first');
      return;
    }
    transcript.push('user', echo);
    setMode({ type: 'running' });
    work(session).catch((err: unknown) => {
      transcript.push('error', err instanceof Error ? err.message : String(err));
      setMode({ type: 'idle' });
    });
  };

  switch (command.type) {
    case 'unknown':
      transcript.push('error', `unknown command: ${command.command} — type /help`);
      return;

    case 'usage':
      transcript.push('error', command.message);
      return;

    case 'plan':
      start(`/plan ${command.args}`, s => s.plan(command.args));
      return;

    case 'review':
      start(command.args ? `/review ${command.args}` : '/review',
            s => s.review(command.args || undefined));
      return;

    case 'help':
      transcript.push('info', HELP);
      return;

    case 'exit':
      deps.quit();
      return;

    case 'cwd':
      transcript.push('info', deps.workspaceRoot);
      return;

    case 'model':
      if (command.target === 'off') deps.applyProfiles(deps.activeProfile, undefined);
      else if (command.target === 'both') setMode({ type: 'setup', tier: 'deep', chain: true });
      else setMode({ type: 'setup', tier: command.target, chain: false });
      return;

    case 'tokens': {
      const on = deps.prefs.toggle('showUsage');
      transcript.push('info', `token usage ${on ? 'shown' : 'hidden'} after each response`);
      return;
    }

    case 'stream': {
      const on = deps.prefs.toggle('stream');
      if (!on) transcript.clearStream();
      transcript.push('info', on
        ? 'streaming responses as they arrive'
        : 'responses shown only when complete');
      return;
    }

    case 'memory': {
      const path = join(deps.workspaceRoot, 'AGENTS.md');
      if (!existsSync(path)) {
        transcript.push('info',
          'No AGENTS.md found. Create one in the workspace root to give the agent persistent context.');
        return;
      }
      readFile(path, 'utf8')
        .then(content => transcript.push('markdown', content, { title: 'AGENTS.md', note: 'project memory' }))
        .catch(() => transcript.push('error', 'Could not read AGENTS.md'));
      return;
    }

    case 'login':
      try {
        const login = deps.startLogin();
        transcript.push('info',
          `Opening browser…\n\nIf it doesn't open, visit:\n${login.authUrl}\n\nPaste the code shown on the page below.`);
        setMode({ type: 'login-pending', session: login });
      } catch (err: unknown) {
        transcript.push('error', err instanceof Error ? err.message : String(err));
      }
      return;

    case 'clear':
      deps.approvals.denyAll();
      void session?.clear().then((summary) => {
        // Wipe the terminal too — the point of /clear is a clean slate, and the
        // committed rows above are already scrolled into the user's scrollback.
        process.stdout.write('\x1Bc');
        transcript.reset([
          deps.headerMessage(),
          { key: transcript.nextKey(), role: 'info', content: summary },
        ]);
        deps.setSteering(false);
      });
      return;
  }
}
