import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { runSlashCommand } from './commands.js';
import type { CommandDeps, CommandSession } from './commands.js';
import type { Transcript } from './hooks/useTranscript.js';
import type { Mode } from './mode.js';
import type { Message } from './view/message.js';
import type {
  AgentProfile, AgentJob, McpServerState, RuntimeMode, SafetyLevel, SafetyAgentConfig, UsageReport,
} from '@agentionai/marshall-engine';
import type { BackgroundJob } from '@agentionai/marshall-tools';

// ── fakes ─────────────────────────────────────────────────────────────────────

interface Pushed { role: string; content: string }

function fakeTranscript() {
  const pushed: Pushed[] = [];
  let reset: Message[] | null = null;
  let key = 0;
  const transcript = {
    messages: [], stream: '', reasoning: '', epoch: 0,
    push: (role: string, content: string) => { pushed.push({ role, content }); },
    reset: (messages: Message[]) => { reset = messages; },
    nextKey: () => String(++key),
    appendStream: () => {}, clearStream: () => {}, takeStream: () => '',
    appendReasoning: () => {}, takeReasoning: () => '',
    replay: () => {},
  } as unknown as Transcript;
  return { transcript, pushed, get reset() { return reset; } };
}

const PROFILE: AgentProfile = { provider: 'claude', model: 'claude-sonnet-4-6' };

function setup(overrides: Partial<CommandDeps> & {
  jobs?: BackgroundJob[];
  servers?: McpServerState[];
  agents?: AgentJob[];
  activity?: Record<string, string[]>;
  runtime?: RuntimeMode;
} = {}) {
  const t = fakeTranscript();
  const modes: Mode[] = [];
  const calls = {
    plan: [] as string[],
    goal: [] as string[],
    review: [] as (string | undefined)[],
    cleared: 0,
    denyAll: 0,
    quit: 0,
    applied: [] as Array<[AgentProfile, AgentProfile | undefined]>,
    steering: [] as boolean[],
    killed: [] as string[],
    killedAll: 0,
    mcpRemoved: [] as string[],
    mcpReconnected: [] as string[],
    mcpChanged: 0,
    light: [] as boolean[],
    runtime: [] as RuntimeMode[],
    agentStopped: [] as string[],
    agentsStoppedAll: 0,
    runtimeMode: [] as Array<[string, string]>,
    safetyLevel: [] as SafetyLevel[],
    safetyAgent: [] as Array<SafetyAgentConfig | undefined>,
    safetyLevelReported: [] as SafetyLevel[],
  };

  const jobs = overrides.jobs ?? [];
  const servers = overrides.servers ?? [];
  const agents = overrides.agents ?? [];
  const usage: UsageReport = {
    turn: { inputTokens: 10, outputTokens: 20 },
    session: { inputTokens: 100, outputTokens: 200, costUsd: 0.0421 },
    byRole: [
      { role: 'coder', model: 'openrouter/openai/gpt-5.6-luna', inputTokens: 90, outputTokens: 190, costUsd: 0.0411 },
      { role: 'context', model: 'llamacpp/qwen3-8b', inputTokens: 10, outputTokens: 10, costUsd: 0 },
    ],
  };
  let light = false;
  let runtime: RuntimeMode = overrides.runtime ?? 'default';
  let safetyLevel: SafetyLevel = 2;

  const session: CommandSession = {
    plan: async (task) => { calls.plan.push(task); },
    goal: async (task) => { calls.goal.push(task); },
    review: async (notes) => { calls.review.push(notes); },
    clear: async () => { calls.cleared++; return 'history cleared'; },
    backgroundJobs: {
      list: () => jobs,
      kill: (id) => { calls.killed.push(id); return jobs.some(j => j.id === id && j.status === 'running'); },
      killAll: () => { calls.killedAll++; },
    },
    usageReport: () => usage,
    mcpState: () => servers,
    removeMcpServer: async (name) => {
      calls.mcpRemoved.push(name);
      return servers.some(s => s.name === name);
    },
    reconnectMcpServer: async (name) => {
      calls.mcpReconnected.push(name);
      return servers.find(s => s.name === name) ?? null;
    },
    agents: {
      list: () => agents,
      activity: (id) => overrides.activity?.[id] ?? [],
      kill: (id) => { calls.agentStopped.push(id); return agents.some(a => a.id === id && a.status === 'running'); },
      killAll: () => { calls.agentsStoppedAll++; },
    },
    get light() { return light; },
    setLight: (next) => { light = next; calls.light.push(next); },
    get runtime() { return runtime; },
    setRuntime: (next) => { runtime = next; calls.runtime.push(next); },
    get safetyLevel() { return safetyLevel; },
    setSafetyLevel: (next) => { safetyLevel = next; calls.safetyLevel.push(next); },
    setSafetyAgent: (agent) => { calls.safetyAgent.push(agent); },
  };

  const prefs = {
    stream: true, showReasoning: false,
    toggle: (key: 'stream' | 'showReasoning') => {
      const next = !prefs[key];
      (prefs as Record<string, unknown>)[key] = next;
      return next;
    },
    read: () => ({ stream: prefs.stream, showReasoning: prefs.showReasoning }),
  };

  const deps: CommandDeps = {
    workspaceRoot: '/tmp/workspace',
    transcript: t.transcript,
    session,
    approvals: {
      pending: 0,
      enqueue: () => ({ promise: Promise.resolve('approve' as const), show: null }),
      resolve: () => null,
      denyAll: () => { calls.denyAll++; return 0; },
    },
    prefs: prefs as unknown as CommandDeps['prefs'],
    setMode: (mode) => { modes.push(mode); },
    setSteering: (value) => { calls.steering.push(value); },
    headerMessage: () => ({ key: 'h', role: 'header', content: '' }),
    applyProfiles: (deep, fast) => { calls.applied.push([deep, fast]); },
    activeProfile: PROFILE,
    quit: () => { calls.quit++; },
    startLogin: () => ({ authUrl: 'https://auth.example' } as never),
    onMcpChanged: () => { calls.mcpChanged++; },
    onSafetyLevelChange: (level) => { calls.safetyLevelReported.push(level); },
    onRuntimeModeChange: (mode, scope) => { calls.runtimeMode.push([mode, scope]); },
    ...overrides,
  };

  return { deps, modes, calls, pushed: t.pushed, transcript: t };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('runSlashCommand', () => {
  it('reports an unrecognised command without touching the session', () => {
    const { deps, pushed, modes } = setup();
    runSlashCommand('/nope', deps);
    assert.equal(pushed[0].role, 'error');
    assert.match(pushed[0].content, /unknown command: \/nope/);
    assert.deepEqual(modes, []);
  });

  it('reports misuse with the command’s own usage line', () => {
    const { deps, pushed } = setup();
    runSlashCommand('/plan', deps);
    assert.equal(pushed[0].role, 'error');
    assert.match(pushed[0].content, /usage: \/plan/);
  });

  it('echoes /plan, runs it, and goes busy', async () => {
    const { deps, calls, pushed, modes } = setup();
    runSlashCommand('/plan add a login form', deps);
    assert.deepEqual(calls.plan, ['add a login form']);
    assert.deepEqual(pushed, [{ role: 'user', content: '/plan add a login form' }]);
    assert.deepEqual(modes, [{ type: 'running' }]);
  });

  it('echoes /goal, runs it, and goes busy', async () => {
    const { deps, calls, pushed, modes } = setup();
    runSlashCommand('/goal add a login form', deps);
    assert.deepEqual(calls.goal, ['add a login form']);
    assert.deepEqual(pushed, [{ role: 'user', content: '/goal add a login form' }]);
    assert.deepEqual(modes, [{ type: 'running' }]);
  });

  it('passes undefined for a bare /review', () => {
    const { deps, calls } = setup();
    runSlashCommand('/review', deps);
    assert.deepEqual(calls.review, [undefined]);
  });

  it('returns to idle and surfaces the error when a task rejects', async () => {
    const { deps, pushed, modes } = setup({
      session: {
        plan: async () => { throw new Error('provider unreachable'); },
        goal: async () => {},
        review: async () => {},
        clear: async () => 'cleared',
        backgroundJobs: { list: () => [], kill: () => false, killAll: () => {} },
        mcpState: () => [],
        removeMcpServer: async () => false,
        reconnectMcpServer: async () => null,
      },
    });
    runSlashCommand('/plan something', deps);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(modes, [{ type: 'running' }, { type: 'idle' }]);
    assert.deepEqual(pushed.at(-1), { role: 'error', content: 'provider unreachable' });
  });

  it('refuses to start work before a model is chosen', () => {
    const { deps, pushed, modes } = setup({ session: null });
    runSlashCommand('/plan something', deps);
    assert.equal(pushed[0].role, 'error');
    assert.deepEqual(modes, [], 'must not strand the UI in running mode');
  });

  it('opens the scoped settings menu for /setup', () => {
    const { deps, modes } = setup();
    runSlashCommand('/setup', deps);
    runSlashCommand('/setup global', deps);
    assert.deepEqual(modes, [
      { type: 'settings-menu', scope: 'project' },
      { type: 'settings-menu', scope: 'global' },
    ]);
  });

  it('opens the wizard on the tier /model names', () => {
    const { deps, modes } = setup();
    runSlashCommand('/model', deps);
    runSlashCommand('/model deep', deps);
    runSlashCommand('/model fast', deps);
    assert.deepEqual(modes, [
      { type: 'setup', tier: 'deep', chain: true },
      { type: 'setup', tier: 'deep', chain: false },
      { type: 'setup', tier: 'fast', chain: false },
    ]);
  });

  it('drops the fast tier on /model off without opening the wizard', () => {
    const { deps, modes, calls } = setup();
    runSlashCommand('/model off', deps);
    assert.deepEqual(calls.applied, [[PROFILE, undefined]]);
    assert.deepEqual(modes, []);
  });

  it('toggles preferences and says which way they went', () => {
    const { deps, pushed } = setup();
    runSlashCommand('/stream', deps);
    assert.match(pushed[0].content, /only when complete/);
  });

  it('reports what the session has spent on /tokens', () => {
    const { deps, pushed } = setup();
    runSlashCommand('/tokens', deps);
    assert.match(pushed[0].content, /session/);
    assert.match(pushed[0].content, /coder/, 'the per-agent breakdown is the point of the command');
  });

  it('prints the workspace for /cwd and the help text for /help', () => {
    const { deps, pushed } = setup();
    runSlashCommand('/cwd', deps);
    assert.deepEqual(pushed[0], { role: 'info', content: '/tmp/workspace' });
    runSlashCommand('/help', deps);
    assert.match(pushed[1].content, /\/model/);
  });

  it('quits on /exit', () => {
    const { deps, calls } = setup();
    runSlashCommand('/exit', deps);
    assert.equal(calls.quit, 1);
  });

  it('explains a missing AGENTS.md rather than erroring', () => {
    const { deps, pushed } = setup();
    runSlashCommand('/memory', deps);
    assert.equal(pushed[0].role, 'info');
    assert.match(pushed[0].content, /No AGENTS\.md/);
  });

  it('starts a login and waits for the pasted code', () => {
    const { deps, pushed, modes } = setup();
    runSlashCommand('/login', deps);
    assert.match(pushed[0].content, /https:\/\/auth\.example/);
    assert.equal(modes[0].type, 'login-pending');
  });

  it('denies pending approvals and rebuilds the transcript on /clear', async () => {
    const { deps, calls, transcript } = setup();
    const write = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      runSlashCommand('/clear', deps);
      await new Promise(resolve => setImmediate(resolve));
    } finally {
      process.stdout.write = write;
    }

    assert.equal(calls.denyAll, 1);
    assert.equal(calls.cleared, 1);
    assert.deepEqual(calls.steering, [false]);
    assert.equal(transcript.reset?.[0].role, 'header');
    assert.equal(transcript.reset?.[1].content, 'history cleared');
  });
});

describe('/agents', () => {
  const agent = (over: Partial<AgentJob> = {}): AgentJob => ({
    id: 'agent1',
    brief: 'restyle the header in packages/ui',
    tier: 'fast',
    toolset: 'edit',
    label: 'openrouter/some-model',
    startedAt: Date.now() - 5000,
    status: 'running',
    ...over,
  });

  it('points at the runtime when the model could not have spawned anything', () => {
    const { deps, pushed } = setup();
    runSlashCommand('/agents', deps);
    assert.equal(pushed[0].role, 'info');
    // "none" alone would leave the user waiting for something that cannot
    // happen on this runtime.
    assert.match(pushed[0].content, /runtime agentic/);
  });

  it('says none, without the hint, once the swarm is on', () => {
    const { deps, pushed } = setup({ runtime: 'agentic' });
    runSlashCommand('/agents', deps);
    assert.match(pushed[0].content, /no agents have been spawned/);
    assert.doesNotMatch(pushed[0].content, /runtime agentic/);
  });

  it('lists each agent by the brief it was approved for', () => {
    const { deps, pushed } = setup({
      runtime: 'agentic',
      agents: [agent(), agent({ id: 'agent2', tier: 'deep', status: 'done', endedAt: Date.now() })],
    });
    runSlashCommand('/agents', deps);
    assert.match(pushed[0].content, /agent1.*running.*fast\/edit.*restyle the header/s);
    assert.match(pushed[0].content, /agent2.*done.*deep/s);
  });

  it('truncates a brief that is a paragraph', () => {
    const { deps, pushed } = setup({
      runtime: 'agentic',
      agents: [agent({ brief: 'x'.repeat(200) })],
    });
    runSlashCommand('/agents', deps);
    const line = pushed[0].content.split('\n')[0];
    assert.ok(line.length < 120, `a list row should stay a row, got ${line.length} chars`);
    assert.match(line, /…/);
  });

  it('shows what a running agent last did, since elapsed time alone cannot', () => {
    const { deps, pushed } = setup({
      runtime: 'agentic',
      agents: [agent()],
      activity: { agent1: ['list_dir', 'read_file', 'search'] },
    });
    runSlashCommand('/agents', deps);
    assert.match(pushed[0].content, /last: search/);
  });

  it('does not claim a last action for an agent that has stopped', () => {
    const { deps, pushed } = setup({
      runtime: 'agentic',
      agents: [agent({ status: 'done', endedAt: Date.now() })],
      activity: { agent1: ['read_file'] },
    });
    runSlashCommand('/agents', deps);
    assert.doesNotMatch(pushed[0].content, /last:/);
  });

  it('stops one agent by id', () => {
    const { deps, calls, pushed } = setup({ runtime: 'agentic', agents: [agent()] });
    runSlashCommand('/agents stop agent1', deps);
    assert.deepEqual(calls.agentStopped, ['agent1']);
    assert.match(pushed[0].content, /stopped agent1/);
  });

  it('reports an id that is not running rather than claiming success', () => {
    const { deps, pushed } = setup({
      runtime: 'agentic',
      agents: [agent({ status: 'done', endedAt: Date.now() })],
    });
    runSlashCommand('/agents stop agent1', deps);
    assert.match(pushed[0].content, /not a running agent/);
  });

  it('stops everything on "stop all" and counts what it stopped', () => {
    const { deps, calls, pushed } = setup({
      runtime: 'agentic',
      agents: [agent(), agent({ id: 'agent2' })],
    });
    runSlashCommand('/agents stop all', deps);
    assert.equal(calls.agentsStoppedAll, 1);
    assert.match(pushed[0].content, /stopped 2 agents/);
  });

  it('rejects a verb it does not have with usage', () => {
    const { deps, pushed } = setup({ runtime: 'agentic' });
    runSlashCommand('/agents kill agent1', deps);
    assert.equal(pushed[0].role, 'error');
    assert.match(pushed[0].content, /usage: \/agents/);
  });
});

describe('/jobs', () => {
  const job = (over: Partial<BackgroundJob> = {}): BackgroundJob => ({
    id: 'job1',
    command: 'npm run dev',
    startedAt: Date.now() - 5000,
    status: 'running',
    exitCode: null,
    ...over,
  });

  it('says so when nothing has been backgrounded', () => {
    const { deps, pushed } = setup();
    runSlashCommand('/jobs', deps);
    assert.equal(pushed[0].role, 'info');
    assert.match(pushed[0].content, /no background jobs/);
  });

  it('lists each job with its command and state', () => {
    const { deps, pushed } = setup({
      jobs: [job(), job({ id: 'job2', command: 'npm test', status: 'exited', exitCode: 1, endedAt: Date.now() })],
    });
    runSlashCommand('/jobs', deps);
    assert.match(pushed[0].content, /job1.*running.*npm run dev/s);
    assert.match(pushed[0].content, /job2.*exited \(1\).*npm test/s);
  });

  it('kills one job by id', () => {
    const { deps, calls, pushed } = setup({ jobs: [job()] });
    runSlashCommand('/jobs kill job1', deps);
    assert.deepEqual(calls.killed, ['job1']);
    assert.match(pushed[0].content, /killed job1/);
  });

  it('reports an id that is not running rather than claiming success', () => {
    const { deps, pushed } = setup({ jobs: [job({ status: 'exited', exitCode: 0 })] });
    runSlashCommand('/jobs kill job1', deps);
    assert.match(pushed[0].content, /not a running job/);
  });

  it('kills everything on "kill all" and counts what it stopped', () => {
    const { deps, calls, pushed } = setup({ jobs: [job(), job({ id: 'job2' })] });
    runSlashCommand('/jobs kill all', deps);
    assert.equal(calls.killedAll, 1);
    assert.match(pushed[0].content, /killed 2 background jobs/);
  });

  it('rejects a malformed argument with usage', () => {
    const { deps, pushed } = setup();
    runSlashCommand('/jobs nonsense', deps);
    assert.equal(pushed[0].role, 'error');
    assert.match(pushed[0].content, /usage: \/jobs/);
  });

  it('refuses before a model is chosen', () => {
    const { deps, pushed } = setup({ session: null });
    runSlashCommand('/jobs', deps);
    assert.equal(pushed[0].role, 'error');
  });
});

describe('/mcp', () => {
  const server = (over: Partial<McpServerState> = {}): McpServerState => ({
    name: 'linear',
    url: 'https://mcp.linear.app/mcp',
    status: 'connected',
    toolNames: ['create_issue', 'search_issues'],
    ...over,
  });

  it('points at /mcp add when nothing is configured', () => {
    const { deps, pushed } = setup();
    runSlashCommand('/mcp', deps);
    assert.equal(pushed[0].role, 'info');
    assert.match(pushed[0].content, /no MCP servers configured/);
  });

  it('lists each server with its status and the tools it offers', () => {
    const { deps, pushed } = setup({ servers: [server()] });
    runSlashCommand('/mcp', deps);
    assert.match(pushed[0].content, /linear\s+connected/);
    assert.match(pushed[0].content, /2 tools: create_issue, search_issues/);
  });

  it('shows the reason a server failed instead of just "error"', () => {
    const { deps, pushed } = setup({
      servers: [server({ status: 'error', toolNames: [], error: 'ECONNREFUSED' })],
    });
    runSlashCommand('/mcp', deps);
    assert.match(pushed[0].content, /ECONNREFUSED/);
  });

  it('keeps dangling project selections in the informational status style', () => {
    const { deps, pushed } = setup({
      mcpWarnings: ['"garmin" is selected but no server is defined'],
    });
    runSlashCommand('/mcp', deps);
    assert.equal(pushed[0].role, 'info');
    assert.match(pushed[0].content, /garmin/);
  });

  it('opens the wizard for /mcp add rather than doing anything itself', () => {
    const { deps, modes, pushed } = setup();
    runSlashCommand('/mcp add', deps);
    assert.deepEqual(modes, [{ type: 'mcp-setup' }]);
    assert.deepEqual(pushed, []);
  });

  it('removes a server and persists the change', async () => {
    const { deps, calls, pushed } = setup({ servers: [server()] });
    runSlashCommand('/mcp remove linear', deps);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls.mcpRemoved, ['linear']);
    assert.equal(calls.mcpChanged, 1, 'a removed server must not come back next session');
    assert.match(pushed[0].content, /removed linear/);
  });

  it('does not persist when the named server was not configured', async () => {
    const { deps, calls, pushed } = setup();
    runSlashCommand('/mcp remove ghost', deps);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.mcpChanged, 0);
    assert.match(pushed[0].content, /not a configured MCP server/);
  });

  it('reconnects a server and reports the new state', async () => {
    const { deps, calls, pushed } = setup({ servers: [server()] });
    runSlashCommand('/mcp reconnect linear', deps);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls.mcpReconnected, ['linear']);
    assert.match(pushed[0].content, /linear\s+connected/);
  });

  it('rejects a malformed argument with usage', () => {
    const { deps, pushed } = setup();
    runSlashCommand('/mcp frobnicate', deps);
    assert.equal(pushed[0].role, 'error');
    assert.match(pushed[0].content, /usage: \/mcp/);
  });

  it('refuses before a model is chosen', () => {
    const { deps, pushed, modes } = setup({ session: null });
    runSlashCommand('/mcp', deps);
    assert.equal(pushed[0].role, 'error');
    assert.deepEqual(modes, []);
  });
});

describe('/runtime', () => {
  it('turns the lean belt on and says which tools just went away', () => {
    const { deps, pushed, calls } = setup();
    runSlashCommand('/runtime light', deps);
    assert.deepEqual(calls.runtime, ['light']);
    assert.equal(pushed[0].role, 'info');
    // The saving is the reason to use it, and the missing tools are the cost —
    // a bare "light mode on" leaves the user to discover the cost mid-task.
    assert.match(pushed[0].content, /scratchpad|background|sub-agents/);
    assert.match(pushed[0].content, /next message/,
      'the belt is rebuilt per turn, so the change is not retroactive');
  });

  it('goes back to the full belt', () => {
    const { deps, calls } = setup();
    runSlashCommand('/runtime light', deps);
    runSlashCommand('/runtime default', deps);
    assert.deepEqual(calls.runtime, ['light', 'default']);
  });

  it('reports the current mode without changing it', () => {
    const { deps, pushed, calls } = setup();
    runSlashCommand('/runtime', deps);
    assert.equal(pushed[0].role, 'info');
    assert.match(pushed[0].content, /runtime: default/);
    assert.deepEqual(calls.runtime, [], 'a bare /runtime only informs');
    assert.deepEqual(calls.runtimeMode, [], 'and saves nothing');
  });

  it('persists to the project by default', () => {
    const { deps, calls } = setup();
    runSlashCommand('/runtime light', deps);
    assert.deepEqual(calls.runtimeMode, [['light', 'project']]);
  });

  it('persists globally with --global, and says so', () => {
    const { deps, pushed, calls } = setup();
    runSlashCommand('/runtime light --global', deps);
    assert.deepEqual(calls.runtimeMode, [['light', 'global']]);
    assert.match(pushed[0].content, /every workspace/);
  });

  it('turns the swarm on, and says what that costs the user', () => {
    const { deps, pushed, calls } = setup();
    runSlashCommand('/runtime agentic', deps);
    assert.deepEqual(calls.runtime, ['agentic']);
    assert.equal(pushed[0].role, 'info');
    // Handing a model the ability to start other models is worth one sentence
    // about what it means, and one about how to see what it started.
    assert.match(pushed[0].content, /spawn|agents/i);
    assert.match(pushed[0].content, /approval/i);
    assert.deepEqual(calls.runtimeMode, [['agentic', 'project']], 'and it is saved like any other mode');
  });

  it('rejects an unknown mode with usage', () => {
    const { deps, pushed, calls } = setup();
    runSlashCommand('/runtime on', deps);
    assert.equal(pushed[0].role, 'error');
    assert.match(pushed[0].content, /usage: \/runtime/);
    assert.deepEqual(calls.light, [], 'nothing is toggled by a misuse');
  });

  it('refuses before a model is chosen', () => {
    const { deps, pushed } = setup({ session: null });
    runSlashCommand('/runtime light', deps);
    assert.equal(pushed[0].role, 'error');
  });
});

describe('/safety', () => {
  it('shows the current level and what each level does on a bare /safety', () => {
    const { deps, pushed, calls } = setup();
    runSlashCommand('/safety', deps);
    assert.equal(pushed[0].role, 'info');
    assert.match(pushed[0].content, /usage: \/safety/);
    assert.match(pushed[0].content, /yolo/);
    assert.match(pushed[0].content, /agentic/);
    assert.match(pushed[0].content, /current: default/);
    assert.deepEqual(calls.safetyLevel, [], 'a bare /safety only informs, it never changes anything');
  });

  it('applies "default" directly and confirms it', () => {
    const { deps, pushed, calls } = setup();
    runSlashCommand('/safety default', deps);
    assert.deepEqual(calls.safetyLevel, [2]);
    assert.deepEqual(calls.safetyLevelReported, [2], 'mirrored to the header');
    assert.equal(pushed[0].role, 'info');
    assert.match(pushed[0].content, /safety: default/);
  });

  it('applies "yolo" directly with a visible warning', () => {
    const { deps, pushed, calls } = setup();
    runSlashCommand('/safety yolo', deps);
    assert.deepEqual(calls.safetyLevel, [1]);
    assert.equal(pushed[0].role, 'info');
    assert.match(pushed[0].content, /⚠/);
    assert.match(pushed[0].content, /dangerous/);
  });

  it('opens the judge-model wizard for "agentic" instead of applying anything itself', () => {
    const { deps, modes, calls } = setup();
    runSlashCommand('/safety agentic', deps);
    assert.deepEqual(modes, [{ type: 'safety-setup' }]);
    assert.deepEqual(calls.safetyLevel, [], 'level 3 only takes effect once a judge model is actually chosen');
  });

  it('rejects an unknown level with usage', () => {
    const { deps, pushed, calls } = setup();
    runSlashCommand('/safety none', deps);
    assert.equal(pushed[0].role, 'error');
    assert.match(pushed[0].content, /usage: \/safety/);
    assert.deepEqual(calls.safetyLevel, []);
  });

  it('refuses before a model is chosen', () => {
    const { deps, pushed } = setup({ session: null });
    runSlashCommand('/safety', deps);
    assert.equal(pushed[0].role, 'error');
  });
});
