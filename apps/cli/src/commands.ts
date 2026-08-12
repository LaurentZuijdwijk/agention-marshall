// ── running a slash command ───────────────────────────────────────────────────
//
// The parser (slashCommands.ts) says what was typed; this says what it does.
// Everything it touches arrives in `deps`, so the whole command surface can be
// exercised without React, Ink or a real Session.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentProfile, AgentJob, McpServerState, SafetyLevel, SafetyAgentConfig, UsageReport,
} from '@agentionai/marshall-engine';
import { formatUsageReport } from './format.js';
import type { BackgroundJob } from '@agentionai/marshall-tools';
import type { Approvals } from './hooks/useApprovals.js';
import type { PreferencesController } from './hooks/usePreferences.js';
import type { Transcript } from './hooks/useTranscript.js';
import type { Message } from './view/message.js';
import type { LoginSession } from './login.js';
import type { SetMode } from './mode.js';
import { resolveSlashCommand, HELP, SAFETY_LEVEL_WORDS, SAFETY_LEVEL_LABELS } from './slashCommands.js';
import type { SafetyLevelWord } from './slashCommands.js';
import type { RuntimeMode, SettingsScope } from './services/settings.js';
import { currentVersion, checkForUpdate, describeUpdate, manualInstallCommand } from './update-check.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** The subset of the engine Session the commands need. */
export interface CommandSession {
  plan(task: string): Promise<unknown>;
  goal(task: string): Promise<unknown>;
  review(notes?: string): Promise<unknown>;
  clear(): Promise<string>;
  backgroundJobs: {
    list(): BackgroundJob[];
    kill(id: string): boolean;
    killAll(): void;
  };
  usageReport(): UsageReport;
  mcpState(): McpServerState[];
  removeMcpServer(name: string): Promise<boolean>;
  reconnectMcpServer(name: string): Promise<McpServerState | null>;
  agents: {
    list(): AgentJob[];
    activity(id: string): string[];
    kill(id: string): boolean;
    killAll(): void;
  };
  readonly light: boolean;
  setLight(light: boolean): void;
  readonly runtime: RuntimeMode;
  setRuntime(mode: RuntimeMode): void;
  readonly safetyLevel: SafetyLevel;
  setSafetyLevel(level: SafetyLevel): void;
  setSafetyAgent(agent: SafetyAgentConfig | undefined): void;
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
  /** Persist the runtime mode, in the project config or globally. The App owns
   *  the write so this stays free of the filesystem. */
  onRuntimeModeChange?(mode: RuntimeMode, scope: SettingsScope): void;
  /** Config problems that produce no server, e.g. a project enabling a name
   *  nothing defines. Shown by `/mcp`, which is where someone goes looking. */
  mcpWarnings?: string[];
  /** Mirrors the session's safety level into the header/banner — `/safety` is
   *  session-only (see Session.setSafetyLevel), so this is what lets a header
   *  reprinted later (mid-session model switch, `/clear`) still show it. */
  onSafetyLevelChange?(level: SafetyLevel): void;
}

function describeJob(job: BackgroundJob): string {
  const elapsed = ((job.endedAt ?? Date.now()) - job.startedAt) / 1000;
  const state = job.status === 'running'
    ? `running ${elapsed.toFixed(0)}s`
    : `${job.status} (${job.exitCode ?? '?'}) after ${elapsed.toFixed(0)}s`;
  return `${job.id}  ${state}  ${job.command}`;
}

/**
 * One line per spawned agent.
 *
 * The brief is what the user approved, so it is what identifies the agent here —
 * an id and a status alone would make "stop the one restyling the header" a
 * guess. Truncated because a brief is a paragraph, and this is a list.
 */
function describeAgent(job: AgentJob, latest?: string): string {
  const elapsed = ((job.endedAt ?? Date.now()) - job.startedAt) / 1000;
  const state = job.status === 'running'
    ? `running ${elapsed.toFixed(0)}s`
    : `${job.status} after ${elapsed.toFixed(0)}s`;
  const brief = job.brief.replace(/\s+/g, ' ').trim();
  const short = brief.length > 60 ? `${brief.slice(0, 59)}…` : brief;
  const head = `${job.id}  ${state}  ${job.tier}/${job.toolset}  ${short}`;
  // The last thing it did, for a running agent only. Elapsed time alone cannot
  // tell thinking from wedged, which is the one question worth asking of an
  // agent that has been going for ten minutes.
  return job.status === 'running' && latest ? `${head}\n    last: ${latest}` : head;
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

    case 'goal':
      start(`/goal ${command.args}`, s => s.goal(command.args));
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

    case 'agents': {
      if (!session) {
        transcript.push('error', 'no model chosen yet — finish setup first');
        return;
      }
      const agents = session.agents;

      if (command.stop === 'all') {
        const running = agents.list().filter(a => a.status === 'running').length;
        agents.killAll();
        transcript.push('info', running > 0
          ? `stopped ${running} agent${running === 1 ? '' : 's'}`
          : 'no agents are running');
        return;
      }

      if (command.stop) {
        transcript.push('info', agents.kill(command.stop)
          ? `stopped ${command.stop}`
          : `${command.stop} is not a running agent`);
        return;
      }

      const all = agents.list();
      if (all.length === 0) {
        // Says why rather than just "none": on the default runtime there is no
        // amount of waiting that would have produced one.
        transcript.push('info', session.runtime === 'agentic'
          ? 'no agents have been spawned in this session'
          : 'no agents — the model can only spawn them on /runtime agentic');
        return;
      }
      transcript.push('info', all.map(a => describeAgent(a, agents.activity(a.id).at(-1))).join('\n'));
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
        .then(async info => {
          if (!info) {
            transcript.push('info', `Marshall ${currentVersion} is up to date`);
            return;
          }
          transcript.push('info', `${describeUpdate(info)}\ninstalling…`);
          try {
            await execFileAsync('npm', ['install', '-g', '@agentionai/marshall-cli@latest']);
            transcript.push('info', 'updated successfully; restart Marshall to use the new version');
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            // A global install fails for reasons we cannot fix from in here —
            // a root-owned prefix, most often — so hand over the command rather
            // than leaving them with only an error.
            transcript.push('error',
              `update failed: ${message}\ninstall it yourself with: ${manualInstallCommand()}`);
          }
        })
        .catch((err: unknown) => transcript.push('error', `update check failed: ${err instanceof Error ? err.message : String(err)}`));
      return;

    case 'tokens': {
      if (!session) {
        transcript.push('error', 'no model chosen yet — finish setup first');
        return;
      }
      transcript.push('info', formatUsageReport(session.usageReport()));
      return;
    }

    case 'runtime': {
      if (!session) {
        transcript.push('error', 'no model chosen yet — finish setup first');
        return;
      }
      const current: RuntimeMode = session.runtime;
      if (!command.mode) {
        transcript.push('info', [
          `runtime: ${current}`,
          '  default — the full tool belt',
          '  light   — lean tool belt for small models: no scratchpad, background jobs',
          '            or sub-agents, and ~1100 fewer tokens per request',
          '  agentic — the full belt plus spawn_agent: the model can put agents to',
          '            work in the background. Costs more, and asks more of you',
          'add --global to save a mode for every workspace',
        ].join('\n'));
        return;
      }
      session.setRuntime(command.mode);
      deps.onRuntimeModeChange?.(command.mode, command.scope);
      // Says what actually changed rather than just the name: a model that can
      // no longer background a test run should not be a surprise mid-task, and
      // neither should one that has just been handed a way to spend money.
      const described = {
        light: 'runtime: light — no scratchpad, background jobs or sub-agents.',
        default: 'runtime: default — the full tool belt.',
        agentic: 'runtime: agentic — the model can now spawn background agents. '
          + 'Each spawn asks your approval first; /agents shows what is running.',
      }[command.mode];
      transcript.push('info', [
        described,
        `Takes effect on your next message, and is saved ${
          command.scope === 'global' ? 'for every workspace' : 'for this workspace'}.`,
      ].join('\n'));
      return;
    }

    case 'safety': {
      if (!session) {
        transcript.push('error', 'no model chosen yet — finish setup first');
        return;
      }

      if (!command.level) {
        const current = SAFETY_LEVEL_LABELS[session.safetyLevel];
        const rows = (Object.keys(SAFETY_LEVEL_WORDS) as SafetyLevelWord[])
          .map(word => `  ${word.padEnd(8)} — ${SAFETY_LEVEL_WORDS[word].blurb}`);
        transcript.push('info', [
          'usage: /safety [yolo|default|agentic]',
          ...rows,
          `current: ${current}`,
        ].join('\n'));
        return;
      }

      if (command.level === 'agentic') {
        // Level 3 needs a judge model before it means anything — the wizard
        // sets `safetyLevel` itself once one is actually chosen.
        setMode({ type: 'safety-setup' });
        return;
      }

      const { level, blurb } = SAFETY_LEVEL_WORDS[command.level];
      session.setSafetyLevel(level);
      deps.onSafetyLevelChange?.(level);
      transcript.push('info', command.level === 'yolo'
        ? `⚠ safety: yolo — ${blurb}`
        : `safety: ${command.level} — ${blurb}`);
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
