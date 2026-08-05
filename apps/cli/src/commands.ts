// ── running a slash command ───────────────────────────────────────────────────
//
// The parser (slashCommands.ts) says what was typed; this says what it does.
// Everything it touches arrives in `deps`, so the whole command surface can be
// exercised without React, Ink or a real Session.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentProfile, McpServerState } from '@agentionai/marshall-engine';
import type { BackgroundJob } from '@agentionai/marshall-tools';
import type { Approvals } from './hooks/useApprovals.js';
import type { PreferencesController } from './hooks/usePreferences.js';
import type { Transcript } from './hooks/useTranscript.js';
import type { Message } from './view/message.js';
import type { LoginSession } from './login.js';
import type { SetMode } from './mode.js';
import { resolveSlashCommand, HELP } from './slashCommands.js';
import { currentVersion, checkForUpdate } from './update-check.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** The subset of the engine Session the commands need. */
export interface CommandSession {
  plan(task: string): Promise<unknown>;
  review(notes?: string): Promise<unknown>;
  clear(): Promise<string>;
  backgroundJobs: {
    list(): BackgroundJob[];
    kill(id: string): boolean;
    killAll(): void;
  };
  mcpState(): McpServerState[];
  removeMcpServer(name: string): Promise<boolean>;
  reconnectMcpServer(name: string): Promise<McpServerState | null>;
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
  /** Persist the server list after `/mcp remove` — the add path saves from the
   *  App, which is where the wizard's result lands. */
  onMcpChanged?(): void;
  /** Config problems that produce no server, e.g. a project enabling a name
   *  nothing defines. Shown by `/mcp`, which is where someone goes looking. */
  mcpWarnings?: string[];
}

function describeJob(job: BackgroundJob): string {
  const elapsed = ((job.endedAt ?? Date.now()) - job.startedAt) / 1000;
  const state = job.status === 'running'
    ? `running ${elapsed.toFixed(0)}s`
    : `${job.status} (${job.exitCode ?? '?'}) after ${elapsed.toFixed(0)}s`;
  return `${job.id}  ${state}  ${job.command}`;
}

/** One block per server: what it is, then what it actually gave us. The tool
 *  names matter — they are what the model sees, and the server chose them. */
function describeServer(server: McpServerState): string {
  const head = `${server.name}  ${server.status}  ${server.url}`;
  if (server.error) return `${head}\n  ${server.error}`;
  if (server.toolNames.length === 0) return head;
  return `${head}\n  ${server.toolNames.length} tools: ${server.toolNames.join(', ')}`;
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

    case 'jobs': {
      if (!session) {
        transcript.push('error', 'no model chosen yet — finish setup first');
        return;
      }
      const jobs = session.backgroundJobs;

      if (command.kill === 'all') {
        const running = jobs.list().filter(j => j.status === 'running').length;
        jobs.killAll();
        transcript.push('info', running > 0
          ? `killed ${running} background job${running === 1 ? '' : 's'}`
          : 'no background jobs are running');
        return;
      }

      if (command.kill) {
        transcript.push('info', jobs.kill(command.kill)
          ? `killed ${command.kill}`
          : `${command.kill} is not a running job`);
        return;
      }

      const all = jobs.list();
      transcript.push('info', all.length === 0
        ? 'no background jobs in this session'
        : all.map(describeJob).join('\n'));
      return;
    }

    case 'mcp': {
      if (!session) {
        transcript.push('error', 'no model chosen yet — finish setup first');
        return;
      }

      if (command.action === 'add') {
        setMode({ type: 'mcp-setup' });
        return;
      }

      if (command.action === 'list') {
        const servers = session.mcpState();
        const warnings = deps.mcpWarnings ?? [];
        const lines = servers.length === 0
          ? ['no MCP servers configured — /mcp add to connect one']
          : servers.map(describeServer);
        // Warnings last: they explain why the list above is shorter than the
        // user expected, so they only make sense after seeing it. This is still
        // a successful status listing; a dangling project selection is a config
        // hint, not a failed MCP connection.
        transcript.push('info', [...lines, ...warnings].join('\n'));
        return;
      }

      // remove / reconnect — both name a server and both are async, so both
      // report only once the engine has actually done the work.
      const { action, server } = command;
      const work = action === 'remove'
        ? session.removeMcpServer(server).then(removed => {
            if (removed) deps.onMcpChanged?.();
            return removed ? `removed ${server}` : `${server} is not a configured MCP server`;
          })
        : session.reconnectMcpServer(server).then(state => state
            ? describeServer(state)
            : `${server} is not a configured MCP server`);

      work
        .then(message => transcript.push('info', message))
        .catch((err: unknown) => transcript.push('error', err instanceof Error ? err.message : String(err)));
      return;
    }

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

    case 'version':
      transcript.push('info', `Marshall ${currentVersion}`);
      return;

    case 'update':
      transcript.push('info', 'checking for updates…');
      checkForUpdate()
        .then(async notice => {
          if (!notice) {
            transcript.push('info', `Marshall ${currentVersion} is up to date`);
            return;
          }
          transcript.push('info', `${notice}\ninstalling…`);
          try {
            await execFileAsync('npm', ['install', '-g', '@agentionai/marshall-cli@latest']);
            transcript.push('info', 'updated successfully; restart Marshall to use the new version');
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            transcript.push('error', `update failed: ${message}`);
          }
        })
        .catch((err: unknown) => transcript.push('error', `update check failed: ${err instanceof Error ? err.message : String(err)}`));
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
