import { join, dirname } from 'node:path';
import { readFile, readdir, rm, appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { History, AgentEvent, BaseAgent } from '@agentionai/agents/core';
import { toolResultMaskingPlugin } from '@agentionai/agents/history/plugins';
import type { ToolResultMaskingPlugin } from '@agentionai/agents/history/plugins';
import {
  createReadOnlyFileTools,
  createAskTool,
  createDedupeCache,
  createBackgroundJobs,
  summariseJob,
  formatJobOutput,
} from '@agentionai/marshall-tools';
import type { DedupeCache, BackgroundJob, BackgroundJobs } from '@agentionai/marshall-tools';
import { createApprovalGate } from './session-approval.js';
import type { ApprovalGate } from './session-approval.js';
import { CompressionManager } from './session-compression.js';
import { createSessionEvents } from './session-events.js';
import type { SessionEvents } from './session-events.js';
import { ToolBelt } from './session-tools.js';
import { McpRegistry } from './mcp.js';
import type { McpServerConfig, McpServerState } from './mcp.js';
import {
  createAgent,
  buildSystemPrompt,
  PLANNER_AGENT_PROMPT,
  GOAL_AGENT_PROMPT,
  REVIEWER_AGENT_PROMPT,
  SURVEY_TOOL_GUIDANCE,
} from './agent-factory.js';
import { runAgent } from './streaming.js';
import { formatTrace, traceMode } from './history-trace.js';
import { checkAttachments, buildInput } from './images.js';
import type { ImageAttachment } from './images.js';
import { describeAgentError, providerErrorDiagnostics, isBadRequestError, isContextLengthError } from './errors.js';
import { resolveRoleProfile, resolveModel, routingSummary, resolveSearchProfile } from './config.js';
import type { EngineConfig, AgentProfile, Role, SafetyLevel, SafetyAgentConfig } from './config.js';
import { createUsageTally, throughputOf } from './usage.js';
import type { PriceBook, UsageReport } from './usage.js';
import type { ClientInterface } from './types.js';

const NEVER_MASK_TOOLS = [
  'list_dir', 'note_write', 'note_read', 'note_list', 'log_append', 'log_read', 'context', 'search',
  // A job id is a handle the model needs later, and it only ever appears in the
  // result of the call that created it. Masking that away strands the job.
  'shell_list',
];

const DEFAULT_AUTO_RESUME_BUDGET = 4;

/**
 * How often a running turn re-reads its agents' token counters.
 *
 * Fast enough that the figure moves while you watch it, slow enough that it is
 * not a render per frame — the counter only changes when a provider response
 * lands, which on a tool-calling turn is every few seconds at best.
 */
const USAGE_SAMPLE_MS = 500;

/**
 * The task given to a turn that a finished job started.
 *
 * The report itself is prepended as context, so this only has to say what to do
 * with it — including that stopping is a valid answer. Without that last clause
 * the model treats an unattended wake-up as a demand for action and invents
 * follow-up work.
 */
const AUTO_RESUME_INSTRUCTION =
  'The background job above finished while you were idle. Continue the work it was part of: ' +
  'if it failed, diagnose and fix it; if it succeeded and more remains, carry on. ' +
  'If nothing further is needed, say so in one short sentence and stop.';

export class Session {
  private readonly history: History;
  private readonly maskingPlugin: ToolResultMaskingPlugin;
  private readonly dedupeCache: DedupeCache;
  /**
   * Files read this session, gating write_file/edit_file on an existing file.
   *
   * Held here rather than inside the file-tool factory because the belt is
   * rebuilt every turn: a factory-owned set makes "read it first" mean "read it
   * first *this turn*", which fails the ordinary read-then-edit-next-turn flow.
   *
   * Path to the content hash the model last saw — see ToolConfig.readFiles.
   */
  private readonly readFiles = new Map<string, string>();
  /** Every agent's token spend, coder and sub-agents alike. */
  private readonly usage = createUsageTally(() => this.prices);
  /** Model prices, once a client that knows any has handed them over. */
  private prices: PriceBook | undefined;
  /** Owns the always-approve list and the safety chain — see session-approval.ts. */
  private readonly approvals: ApprovalGate;
  /** Owns the summariser and history's one compression plugin — see session-compression.ts. */
  private readonly compression: CompressionManager;
  /** Turns SDK events into the client's OutputEvent stream — see session-events.ts. */
  private readonly events: SessionEvents;
  /** Owns the sub-agent tools and the per-turn belt — see session-tools.ts. */
  private readonly toolBelt: ToolBelt;
  private readonly logPath: string;
  private readonly logDirReady: Promise<void>;
  /** Local llama.cpp models are loaded by the first agent construction only. */
  private llamaModelLoaded = false;
  private controller: AbortController | null = null;
  private currentTask: string | null = null;
  private steeringContext: string | null = null;
  private pendingPlan: string | null = null;
  /** Which side agent produced `pendingPlan` — only changes the label the next
   *  run() prepends it under ("[Plan]" vs "[Goal]"); the injection itself is
   *  identical either way. */
  private pendingPlanLabel: 'Plan' | 'Goal' = 'Plan';
  /**
   * Background shell jobs, owned at *session* scope.
   *
   * Not per-run, which is the whole point: the `AbortSignal` in `toolConfig` is
   * recreated and aborted around every turn, so a job wired to it would be
   * killed the moment the turn that started it ended.
   */
  private readonly jobs: BackgroundJobs;
  /**
   * Finished jobs waiting to be told to the model.
   *
   * A queue rather than a direct `history.addText`, because a job can finish at
   * any instant — including between an assistant's `tool_use` and its matching
   * `tool_result`, where injecting a user message produces a malformed
   * conversation that Anthropic rejects outright. Flushed only at the top of a
   * turn, which is always a safe boundary.
   */
  private readonly pendingJobReports: string[] = [];
  /** Turns still allowed to start unattended. Refilled by every user turn. */
  private autoResumeBudget: number;
  private disposed = false;
  /**
   * Remote MCP servers and the tools they offer.
   *
   * Connected in the background from the constructor rather than lazily on
   * first use: a remote handshake is the slowest thing in startup, and doing it
   * eagerly means the first turn usually finds it done. `run` awaits it anyway,
   * so a server that is still connecting delays that turn rather than being
   * silently absent from the belt.
   */
  private readonly mcp: McpRegistry;

  constructor(
    private config: EngineConfig,
    private readonly client: ClientInterface,
  ) {
    this.maskingPlugin = toolResultMaskingPlugin({
      keepRecentResults: config.maskingKeepRecent ?? 3,
      minTokensToMask: 50,
      exclude: NEVER_MASK_TOOLS,
    });

    this.history = new History();
    this.history.use(this.maskingPlugin);
    this.dedupeCache = createDedupeCache();

    // Every collaborator below takes `() => this.config` rather than `config`:
    // the setters further down replace the config object wholesale, so a
    // snapshot would strand them on whatever model and safety level the session
    // started at.
    const getConfig = () => this.config;
    const log = (line: string) => this.log(line);

    this.compression = new CompressionManager(this.history, getConfig, log);
    this.approvals = createApprovalGate({ getConfig, client: this.client, log });
    this.events = createSessionEvents({ client: this.client, getConfig, log });

    this.jobs = createBackgroundJobs({ onExit: (job) => this.onJobExit(job) });
    this.autoResumeBudget = config.autoResumeBudget ?? DEFAULT_AUTO_RESUME_BUDGET;

    this.mcp = new McpRegistry(config.mcpServers);
    if (!this.mcp.isEmpty) void this.mcp.connectAll().then(() => this.reportMcpState());

    this.logPath = join(config.workspaceRoot, '.marshall', 'logs', 'session.log');
    this.logDirReady = mkdir(dirname(this.logPath), { recursive: true }).then(() => {});

    // Last: its constructor builds the sub-agent tools, which needs everything
    // above it (the events sink, the approval gate, the job registry).
    this.toolBelt = new ToolBelt({
      getConfig,
      client: this.client,
      log,
      events: this.events,
      approval: this.approvals.approve,
      jobs: this.jobs,
      usage: this.usage,
      readFiles: this.readFiles,
      dedupeCache: this.dedupeCache,
      maskingPlugin: this.maskingPlugin,
      mcp: this.mcp,
    });

    this.logTierRouting();
  }

  /**
   * Point the session at different models, keeping the conversation.
   *
   * The session is the conversation, not the model behind it — so switching
   * rebuilds only what is bound to a model and leaves everything that carries
   * state: history, the dedupe cache, background jobs, MCP connections and the
   * always-approved list. Rebuilding the Session instead, which is what this
   * replaced, silently discarded all five.
   *
   * Safe to call mid-turn: the running turn captured its coder profile and its
   * tool belt before this, so the change lands on the next one.
   */
  setProfiles(deep: AgentProfile, fast?: AgentProfile): void {
    this.config = { ...this.config, agent: deep, models: { deep, ...(fast ? { fast } : {}) } };
    this.toolBelt.rebuildRoleTools();
    // The plugin stays registered and keeps working; only the model behind it
    // changes. Rebuilt lazily so a switch costs nothing until history is big
    // enough to compress.
    this.compression.invalidateModel();
    this.log(`PROFILES deep=${deep.provider}/${resolveModel(deep)}${fast ? ` fast=${fast.provider}/${resolveModel(fast)}` : ''}`);
    this.logTierRouting();
  }

  get hasSteering(): boolean {
    return this.steeringContext !== null;
  }

  get light(): boolean {
    return this.config.light === true;
  }

  /**
   * Turn light mode on or off, keeping the conversation.
   *
   * Safe mid-turn for the same reason `setProfiles` is: the running turn built
   * its belt and prompt before this, so the change lands on the next one.
   *
   * The history will then contain turns made under two different tool lists.
   * That is survivable — each request carries the current belt, and the model
   * is answering against that — but it is why this is a deliberate toggle
   * rather than something the engine flips on its own: switching every other
   * turn would leave a history describing tools that come and go.
   */
  setLight(light: boolean): void {
    if (this.light === light) return;
    this.config = { ...this.config, light };
    this.toolBelt.rebuildRoleTools();
    this.log(`LIGHT ${light ? 'on' : 'off'}`);
  }

  get safetyLevel(): SafetyLevel {
    return this.config.safetyLevel ?? 2;
  }

  get safetyAgentProfile(): AgentProfile | undefined {
    return this.config.safetyAgent?.profile;
  }

  /** The whole judge config, not just its profile. A caller persisting the
   *  current gate needs `kind` and `maxOutputTokens` too — reading it back off
   *  `safetyAgentProfile` silently drops them and downgrades a content-safety
   *  judge to the default chat-judge shape on the next load. */
  get safetyAgent(): SafetyAgentConfig | undefined {
    return this.config.safetyAgent;
  }

  /**
   * Switch the tool-call approval gate. Safe mid-turn for the same reason
   * `setLight` is: the gate builds its chain from `this.config` fresh on every
   * request (see session-approval.ts), so there is no belt to rebuild.
   */
  setSafetyLevel(level: SafetyLevel): void {
    if (this.safetyLevel === level) return;
    this.config = { ...this.config, safetyLevel: level };
    this.log(`SAFETY_LEVEL ${level}`);
  }

  /** The model that reviews tool calls at safety level 3. Setting it does not
   *  itself change the level — callers that mean to turn level 3 on call
   *  `setSafetyLevel(3)` too. */
  setSafetyAgent(agent: SafetyAgentConfig | undefined): void {
    this.config = { ...this.config, safetyAgent: agent };
    this.log(`SAFETY_AGENT ${agent ? `${agent.profile.provider}/${resolveModel(agent.profile)} kind=${agent.kind ?? 'chat-judge'}` : 'cleared'}`);
  }

  get hasPendingPlan(): boolean {
    return this.pendingPlan !== null;
  }

  /**
   * Hand over model prices, so spend can be reported in money as well as tokens.
   *
   * The engine deliberately does not fetch these. Which catalogue to trust, and
   * whether it is worth a network call at all, is the client's business — the
   * engine's job is only to know what each agent burned.
   */
  setPricing(prices: PriceBook): void {
    this.prices = prices;
    this.log(`PRICING ${prices.size} models`);
  }

  /** What every agent has spent, for `/tokens`. */
  usageReport(): UsageReport {
    return this.usage.report();
  }

  /**
   * Report token spend while the turn is still running, and once more when it
   * ends.
   *
   * A poll, because the SDK has no per-step usage event: `lastTokenUsage`
   * accumulates onto the agent across its own tool-call steps, so reading it is
   * the only way to watch the tally move before the turn is over. Sampling the
   * provider's own count rather than estimating from streamed text keeps the
   * number true — an approximation that drifts from the bill is worse than a
   * number that arrives a second late.
   *
   * Returns the stop function, which takes the final reading. Call it from a
   * `finally`: an interrupted or failed turn spent its tokens too.
   */
  private sampleUsage(
    key: string,
    role: Role,
    profile: AgentProfile,
    agent: BaseAgent<string, string>,
    startMs: number,
  ): () => UsageReport {
    const emit = (final: boolean): UsageReport => {
      const usage = agent.lastTokenUsage;
      if (usage) {
        this.usage.record(key, { role, profile }, {
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          ...(usage.reasoning_tokens !== undefined ? { reasoningTokens: usage.reasoning_tokens } : {}),
        });
      }
      // This agent's own rates, from timings the SDK took inside each API call.
      // The rollup below includes sub-agents, which ran on their own clocks in
      // parallel and so share no wall-clock a rate could be taken over.
      const speed = usage ? throughputOf(usage) : undefined;
      const report = this.usage.report();
      // Silence rather than zeroes, the final reading included. Before the first
      // response lands there is nothing to report yet, and on a provider that
      // never reports usage there is nothing to report at all — "↑0 ↓0" would
      // claim that turn was free instead of admitting it is unknown.
      if (report.turn.inputTokens > 0 || report.turn.outputTokens > 0) {
        this.client.onOutput({
          type: 'usage',
          durationMs: Date.now() - startMs,
          turn: report.turn,
          session: report.session,
          final,
          ...(speed && (speed.input !== undefined || speed.output !== undefined)
            ? { rates: { ...(speed.input !== undefined ? { input: speed.input } : {}), ...(speed.output !== undefined ? { output: speed.output } : {}) } }
            : {}),
          ...(speed?.ttftMs !== undefined ? { ttftMs: speed.ttftMs } : {}),
        });
      }
      return report;
    };

    const timer = setInterval(() => emit(false), USAGE_SAMPLE_MS);
    // The interval must never be the thing keeping the process alive.
    timer.unref?.();

    return () => {
      clearInterval(timer);
      return emit(true);
    };
  }

  /** One line per session recording where each role actually landed — the first
   *  thing worth checking when someone reports the fast tier "doing nothing". */
  private logTierRouting(): void {
    // `search` is special-cased: routingSummary answers "which tier owns this
    // role", but the search tool only exists on a claude profile, so the role's
    // tier is not where it actually runs. Reporting the role here would claim
    // search runs on a local model when in fact it is switched off.
    const search = resolveSearchProfile(this.config);
    const searchLabel = this.config.enableWebSearch === false ? 'off'
      : search === null ? 'unavailable'
      : `${search.provider}/${resolveModel(search)}`;

    const summary = routingSummary(this.config)
      .filter(r => r.role !== 'search')
      .map(r => `${r.role}=${r.provider}/${r.model}${r.delegated ? '*' : ''}`)
      .join(' ');
    // Light is recorded here because it silently overrules every row above it:
    // the roles are still routed, they just have no tool to reach them through.
    // "Why did the context agent never run" is answered by this line or nothing.
    this.log(`TIERS ${summary} search=${searchLabel}${this.config.light ? ' light=on (sub-agents off)' : ''}`);
  }

  private log(entry: string): void {
    const line = `[${new Date().toISOString()}] ${entry}\n`;
    this.logDirReady
      .then(() => appendFile(this.logPath, line))
      .catch(() => {});
  }

  /**
   * Dump the conversation as the model receives it — see history-trace.ts.
   *
   * A separate file from the session log, and read from the environment at call
   * time rather than construction, so turning it on is a matter of restarting
   * with the variable set and turning it off costs nothing at all.
   */
  private traceHistory(label: string): void {
    const mode = traceMode(process.env.MARSHALL_TRACE_HISTORY);
    if (mode === 'off') return;
    const record = formatTrace(this.history, label, mode);
    this.logDirReady
      .then(() => appendFile(join(dirname(this.logPath), 'history.log'), record))
      .catch(() => {});
  }

  /** Remove the failed request's final message before rebuilding the prompt. */
  private popLastHistoryMessage(): boolean {
    const entries = this.history.entries;
    if (entries.length === 0) return false;

    this.history.clear();
    for (const entry of entries.slice(0, -1)) this.history.addEntry(entry);
    this.log('CONTEXT_ERROR_POPPED_LAST_MESSAGE');
    return true;
  }

  // ── background jobs ─────────────────────────────────────────────────────────

  /**
   * A background job ended by itself. Queue what happened, tell the client, and
   * wake the agent if nothing is already running.
   *
   * The output taken here is the *unread* part (`read`, not `tail`): anything
   * the model already pulled with `shell_output` is in its context, and paying
   * for it a second time is how a chatty dev server eats a context window.
   */
  private onJobExit(job: BackgroundJob): void {
    if (this.disposed) return;

    const durationMs = (job.endedAt ?? Date.now()) - job.startedAt;
    this.log(
      `JOB ${job.id} ${job.status} exit=${job.exitCode ?? 'null'} ` +
      `${(durationMs / 1000).toFixed(1)}s ${JSON.stringify(job.command.slice(0, 200))}`,
    );

    this.pendingJobReports.push(this.formatJobReport(job));

    // Announced before any turn starts, so the client can say what is about to
    // happen rather than print a completion and be surprised by a turn starting
    // underneath it.
    this.client.onOutput({
      type: 'job-done',
      id: job.id,
      command: job.command,
      status: job.status === 'timed-out' ? 'timed-out' : 'exited',
      exitCode: job.exitCode,
      durationMs,
      resuming: this.autoResumeAllowed(),
    });

    this.maybeResume();
  }

  private formatJobReport(job: BackgroundJob): string {
    const output = formatJobOutput(this.jobs.read(job.id));
    return `[Background job finished]\n${summariseJob(job)}\n\n${output || '(no output)'}`;
  }

  /**
   * Whether a queued report will be acted on at all — deliberately blind to
   * whether a turn happens to be running right now.
   *
   * That distinction is what makes the `resuming` flag honest. A job finishing
   * mid-turn *is* picked up; just at the end of that turn rather than
   * immediately, because the running turn built its prompt before the job
   * existed. Only a disabled or exhausted auto-resume means "no".
   */
  private autoResumeAllowed(): boolean {
    if (this.disposed) return false;
    if (this.config.autoResume === false) return false;
    return this.autoResumeBudget > 0;
  }

  /**
   * Start a turn for whatever is queued, if this is a moment when one can start.
   *
   * Called both when a job exits and when a turn ends — a job that finished
   * mid-turn was only queued, and the end of that turn is both the first safe
   * point to act on it and the last chance to notice it before the session goes
   * quiet with the report undelivered.
   */
  private maybeResume(): void {
    if (this.pendingJobReports.length === 0) return;
    // A run already in flight claims the controller; `run` would refuse the call
    // and the report would be dropped on the floor. Its own `finally` calls back
    // here once it is done.
    if (this.controller) return;
    if (!this.autoResumeAllowed()) return;
    this.autoResumeBudget -= 1;
    void this.run(AUTO_RESUME_INSTRUCTION, [], { auto: true });
  }

  /**
   * The session's background shell jobs.
   *
   * Exposed so a client can list what is running and stop it — and so work that
   * has no turn behind it (a scheduled command, say) can start a job and still
   * get the same completion-wakes-the-agent behaviour.
   */
  get backgroundJobs(): BackgroundJobs {
    return this.jobs;
  }

  // ── MCP ─────────────────────────────────────────────────────────────────────

  /** Configured servers and what each is currently doing — what `/mcp` renders. */
  mcpState(): McpServerState[] {
    return this.mcp.state();
  }

  /**
   * The server configs, for a client that persists them.
   *
   * Separate from `mcpState` on purpose: state is for display and deliberately
   * omits `headers`, since it is handed to the UI and those headers are bearer
   * tokens. Persisting from state would quietly drop the credential and leave a
   * server that works this session and fails on the next start.
   */
  mcpServers(): McpServerConfig[] {
    return this.mcp.configs;
  }

  /** Add a server, connect it, and report the outcome. Never throws: an
   *  unreachable server comes back as an `error` state, not an exception. */
  async addMcpServer(config: McpServerConfig): Promise<McpServerState> {
    const state = await this.mcp.add(config);
    this.log(`MCP add ${config.name} ${state.status} ${state.error ?? `${state.toolNames.length} tools`}`);
    this.reportMcpState();
    return state;
  }

  async removeMcpServer(name: string): Promise<boolean> {
    const removed = await this.mcp.remove(name);
    if (removed) {
      this.log(`MCP remove ${name}`);
      this.reportMcpState();
    }
    return removed;
  }

  async reconnectMcpServer(name: string): Promise<McpServerState | null> {
    const state = await this.mcp.reconnect(name);
    if (state) {
      this.log(`MCP reconnect ${name} ${state.status} ${state.error ?? ''}`);
      this.reportMcpState();
    }
    return state;
  }

  /** Push the current picture to the client. Emitted on every change so the UI
   *  never has to poll, and once after the initial connect settles. */
  private reportMcpState(): void {
    if (this.disposed) return;
    this.client.onOutput({ type: 'mcp-state', servers: this.mcp.state() });
  }

  /** Stop every background job and close every MCP connection. The processes
   *  are detached and the sockets are open, so a session that goes away without
   *  this leaves both running with nobody reading them. */
  dispose(): void {
    this.disposed = true;
    this.jobs.killAll();
    void this.mcp.disconnect().catch(() => {});
  }

  /**
   * Run one turn.
   *
   * `auto` marks a turn the engine started by itself, after a background job
   * finished. The only differences are that it does not refill the auto-resume
   * budget — otherwise the budget could never run out, which is the entire
   * reason it exists — and that it does not count as user activity. It sits
   * behind `images` so every existing caller keeps its signature.
   */
  async run(
    task: string,
    images: ImageAttachment[] = [],
    options: { auto?: boolean } = {},
  ): Promise<void> {
    if (this.controller) {
      this.client.onOutput({ type: 'error', message: 'A task is already running.' });
      return;
    }

    // Before anything is spent. The refusals this catches are ones where the
    // request would otherwise succeed and mislead — ollama drops images on the
    // floor, so without this the model answers about something it never saw.
    const refusal = checkAttachments(resolveRoleProfile(this.config, 'coder'), images);
    if (refusal) {
      this.client.onOutput({ type: 'error', message: refusal });
      this.log(`REFUSED ${refusal}`);
      return;
    }

    if (!options.auto) {
      this.autoResumeBudget = this.config.autoResumeBudget ?? DEFAULT_AUTO_RESUME_BUDGET;
    }

    this.controller = new AbortController();
    const [, roleTools] = await Promise.all([
      this.compression.ensure(),
      this.toolBelt.ready(),
      // Settles whether the servers connected or failed, so a dead server costs
      // this turn a bounded wait rather than dropping its tools without a word.
      this.mcp.ready(),
    ]);

    // Shrink before the turn rather than mid-turn: the plugin's own trigger was
    // the unhandled-rejection crash, and doing it here keeps it awaited.
    await this.compression.compressIfNeeded();

    const memoryPath = join(this.config.workspaceRoot, 'AGENTS.md');
    const projectMemory = existsSync(memoryPath)
      ? await readFile(memoryPath, 'utf8').catch(() => '')
      : '';

    const steering = this.steeringContext;
    this.steeringContext = null;
    const plan = this.pendingPlan;
    const planLabel = this.pendingPlanLabel;
    this.pendingPlan = null;

    // Every finished job is reported exactly once, at the front of the next
    // turn — whether that turn was started by the user or by the job itself.
    const jobReports = this.pendingJobReports.splice(0);
    const jobBlock = jobReports.length ? `${jobReports.join('\n\n')}\n\n` : '';

    const effectiveTask = jobBlock + (steering
      ? `[Previous task was interrupted: "${steering}"]\n\nNew direction: ${task}`
      : plan
      ? `[${planLabel}]\n${plan}\n\n[Task]\n${task}`
      : task);

    this.currentTask = task;
    let errorReported = false;
    let detachToolResult: (() => void) | null = null;
    let stopSampling: (() => UsageReport) | null = null;
    const startMs = Date.now();
    // Opened before the agent exists, so anything this turn delegates lands in
    // the right turn's column even if the coder itself never reports.
    const usageKey = `coder@${this.usage.startTurn()}`;

    const attached = images.length > 0
      ? ` +${images.length} image${images.length > 1 ? 's' : ''}`
      : '';
    this.log(`TASK ${JSON.stringify(task)}${attached}`);

    // Captured locally (not read from this.controller later) because the underlying
    // agent SDK has no cancellation hook: a real interrupt can only stop us *awaiting*
    // the call, not the in-flight LLM/tool-call loop itself, which keeps running in
    // the background until it naturally ends (every tool call it makes will find
    // signal.aborted and short-circuit). Event listeners below check this exact
    // signal so that abandoned background activity stays silent instead of spamming
    // the UI with a stale task's tool calls after the user has already moved on.
    const signal = this.controller.signal;

    const coderProfile = resolveRoleProfile(this.config, 'coder');

    try {
      const light = this.config.light === true;

      const { tools, extraInstructions } = this.toolBelt.forTurn({
        signal,
        taskContext: task,
        coderProfile,
        roleTools,
      });

      if (coderProfile.provider === 'llamacpp' && !this.llamaModelLoaded) {
        this.client.onOutput({ type: 'model-loading' });
      }
      const agent = await createAgent(coderProfile, tools, this.history, {
        maxTokens: this.config.maxTokens,
        projectMemory: projectMemory || undefined,
        extraInstructions: extraInstructions || undefined,
        // Built from the belt above, so a rule can never describe a tool this
        // turn does not have. The guidance blocks already work this way — they
        // key off whether their tool resolved — and this closes the same gap for
        // the fixed rules.
        systemPrompt: buildSystemPrompt({ scratch: !light, background: !light }),
      });
      if (coderProfile.provider === 'llamacpp') this.llamaModelLoaded = true;

      // Shared with /plan and /review. The per-run file/shell tools die with the
      // run, but the context/search/planner/reviewer tools and the masking
      // plugin's retrieve tool are built once and shared by every run — without
      // the detach in `finally` each turn stacks another listener on those five.
      detachToolResult = this.events.attachToolListeners(agent, tools, signal);
      stopSampling = this.sampleUsage(usageKey, 'coder', coderProfile, agent, startMs);

      agent.on(AgentEvent.ERROR, (err: unknown) => {
        if (signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        const recoverable = isBadRequestError(err) || isContextLengthError(message);
        this.log(`AGENT_ERROR recoverable=${recoverable} ${JSON.stringify(message)} details=${providerErrorDiagnostics(err)}`);
        // Every agent error also rejects the promise `stream()` is awaiting (see
        // createAgent's comment on the safety-net listener), so a recoverable
        // error reaches the try/catch below regardless of whether it's reported
        // here. Reporting it here too would show the raw provider error and end
        // the turn in the client's UI before the try/catch below gets a chance
        // to compress and hand back a friendlier `context-full` event instead.
        if (recoverable) return;
        errorReported = true;
        this.client.onOutput({ type: 'error', message });
        this.log(`ERROR ${message}`);
      });

      // Before the call, not after: this is the document the model is about to
      // be given for `task`, which is what every "it forgot the last answer"
      // report is really asking about. The turn's own message is not in it yet
      // — the agent adds that inside execute — so the pairing to read is this
      // dump against the task named in its own header.
      this.traceHistory(`before ${JSON.stringify(task)}`);
      this.client.onOutput({ type: 'thinking' });
      // Race instead of a plain await: the agent SDK has no cancellation hook, so
      // the run itself won't reject on abort — without this race, Esc would
      // do nothing until the model's current turn (and any tool-blocked retries it
      // attempts afterward) finished on its own, which can take minutes on local models.
      const stream = (input: string | ReturnType<typeof buildInput>): Promise<string> =>
        new Promise<string>((resolve, reject) => {
          runAgent(agent, input, chunk => {
            if (signal.aborted) return;
            this.client.onOutput(chunk.type === 'reasoning'
              ? { type: 'reasoning', text: chunk.content }
              : { type: 'token', text: chunk.content });
          }).then(resolve, reject);
          signal.addEventListener('abort', () => {
            reject(new DOMException('Task interrupted by user', 'AbortError'));
          }, { once: true });
        });

      let response: string;
      try {
        response = await stream(buildInput(effectiveTask, images));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const shouldRecover = isBadRequestError(err) || isContextLengthError(message);
        this.log(`STREAM_ERROR shouldRecover=${shouldRecover} aborted=${signal.aborted} ${JSON.stringify(message)}`);
        if (!shouldRecover || signal.aborted) throw err;

        // Our own token estimate is unreliable for code-heavy content (see
        // contextErrorTarget's comment) — it can miss by 15k+ tokens on a
        // single large file read — so a blind retry is a gamble that can burn
        // a long time and still fail. Rather than guess again, compress once
        // and hand the turn back to the user: fold the abandoned task into
        // `steeringContext`, the same mechanism an Esc-interrupt uses, so
        // their next message carries this one as context instead of losing it.
        //
        // A rejected request has already appended its final assistant/user
        // turn to history. Remove that invalid tail before compressing,
        // otherwise the bad message survives into the summary.
        this.popLastHistoryMessage();
        const compressed = await this.compression.compressForContextError(message);
        this.log(`CONTEXT_ERROR_HANDED_BACK compressed=${compressed}`);
        this.steeringContext = task;
        this.client.onOutput({ type: 'context-full', compressed });
        return;
      }

      // Answer first, then the tally: the usage line accounts for the turn, so
      // it reads as a footer under the answer rather than a header above it.
      // The final reading itself is taken in `finally`, which is the only place
      // that also covers the turns that ended by error or interrupt.
      this.client.onOutput({ type: 'response', text: response });
    } catch (err) {
      if (this.controller?.signal.aborted) {
        try { this.history.addText('user', `[Task was interrupted by the user: "${task}"]`); } catch {}
        this.log(`INTERRUPTED after ${((Date.now() - startMs) / 1000).toFixed(1)}s`);
        this.client.onOutput({ type: 'interrupted' });
      } else if (!errorReported) {
        const message = describeAgentError('coder', coderProfile, err);
        this.log(`ERROR ${message} details=${providerErrorDiagnostics(err)}`);
        this.client.onOutput({ type: 'error', message });
      }
    } finally {
      detachToolResult?.();
      // Before `maybeResume`, which can start the next turn synchronously: the
      // final reading has to be attributed to the turn that spent it, and the
      // sampler for the next one must not be running alongside this one's.
      if (stopSampling) {
        const { turn } = stopSampling();
        this.log(`DONE ↑${turn.inputTokens} ↓${turn.outputTokens} tokens ${((Date.now() - startMs) / 1000).toFixed(1)}s`);
      }
      this.currentTask = null;
      this.controller = null;
      // Paired with the `before` dump above, so the turn's own contribution —
      // its answer, its tool calls and their results — is the diff between the
      // two. In the `finally` because an interrupted or failed turn still
      // leaves history in a state the next turn inherits, and that state is
      // exactly what is worth seeing when a turn went wrong.
      this.traceHistory(`after ${JSON.stringify(task)}`);
      // A job that finished mid-turn was only queued — this is the boundary
      // where acting on it becomes safe, and the last chance to notice it before
      // the session goes idle.
      this.maybeResume();
    }
  }

  /** Shared runner for /plan, /goal and /review — a one-shot, read-only
   *  sub-agent call that doesn't touch the main coder's history or tools. */
  private async runSideAgent(
    profile: AgentProfile,
    systemPrompt: string,
    prompt: string,
    eventType: 'plan' | 'goal' | 'review',
  ): Promise<void> {
    if (this.controller) {
      this.client.onOutput({ type: 'error', message: 'A task is already running.' });
      return;
    }

    this.controller = new AbortController();
    const signal = this.controller.signal;
    const startMs = Date.now();
    let detach: (() => void) | null = null;
    let stopSampling: (() => UsageReport) | null = null;
    // A side agent's work is a turn of its own as far as spend goes: it has its
    // own model, its own sub-agent fan-out, and its own line on the bill.
    const usageKey = `${eventType}@${this.usage.startTurn()}`;
    this.log(`${eventType.toUpperCase()} ${JSON.stringify(prompt)}`);

    try {
      // /plan, /goal and /review are broad by nature — "review the CLI" means
      // reading a whole subtree. Without the context tool the deep model does
      // all of that reading itself, at deep-model prices, which is exactly what
      // the fast tier exists to avoid. Handing it the same tool the coder gets
      // lets it fan the survey out and reason over the summaries instead.
      //
      // No recursion risk: context sub-agents get read-only file tools only, so
      // they cannot call `context` themselves.
      const contextTool = await this.toolBelt.contextTool();
      const tools = [
        ...createReadOnlyFileTools(this.config.workspaceRoot, this.config.limits),
        ...(contextTool ? [contextTool] : []),
        ...((eventType === 'plan' || eventType === 'goal') && this.client.askUser
          ? [createAskTool((request) => this.client.askUser!(request))]
          : []),
      ];
      const agent = await createAgent(profile, tools, new History(), {
        // No cap unless one is configured — a whole-codebase review legitimately
        // runs long, and a fixed ceiling turns that into an error instead of an
        // answer. See resolveMaxTokens.
        maxTokens: this.config.maxTokens,
        systemPrompt,
        extraInstructions: contextTool ? SURVEY_TOOL_GUIDANCE : undefined,
        name: eventType,
      });

      // /plan and /review used to run completely silently — no tool calls, no
      // results — so a long review looked like a hang. Tagged with the agent
      // that made them, since these rows sit at the same level as the coder's.
      detach = this.events.attachToolListeners(agent, tools, signal, eventType);
      // The planner's own role, not the coder's: `/review` on the deep tier and
      // a `context` fan-out on the fast one are two different lines in the
      // breakdown, and rolling them together hides which one costs.
      stopSampling = this.sampleUsage(usageKey, eventType === 'review' ? 'reviewer' : 'planner', profile, agent, startMs);

      this.client.onOutput({ type: 'thinking' });
      const text = await agent.execute(prompt);

      // /goal shares the plan slot rather than getting its own: both exist to
      // prime the next run() call with context the user approved beforehand,
      // and juggling two independent pending-context fields (with their own
      // precedence rules against `steeringContext`) would be complexity run()
      // doesn't need for what is, to it, the same injection either way.
      if (eventType === 'plan' || eventType === 'goal') {
        this.pendingPlan = text;
        this.pendingPlanLabel = eventType === 'goal' ? 'Goal' : 'Plan';
      }
      this.client.onOutput({ type: eventType, text });
    } catch (err) {
      const message = describeAgentError(eventType, profile, err);
      this.log(`ERROR ${message}`);
      this.client.onOutput({ type: 'error', message });
    } finally {
      detach?.();
      // After the result, for the same reason as in run().
      stopSampling?.();
      this.log(`${eventType.toUpperCase()}_DONE ${((Date.now() - startMs) / 1000).toFixed(1)}s`);
      this.controller = null;
      this.maybeResume();
    }
  }

  /** Runs the planner alone (no edits) and holds the result to prepend as
   *  context onto the next run() call — lets the user see/approve the plan
   *  before any code changes happen. */
  async plan(task: string): Promise<void> {
    await this.runSideAgent(resolveRoleProfile(this.config, 'planner'), PLANNER_AGENT_PROMPT, task, 'plan');
  }

  /** Same shape as /plan, but the prompt starts from the destination — what
   *  "done" looks like — before it sketches a rough breakdown, rather than
   *  starting from a step list. Runs on the same tier as /plan — it's a
   *  different framing of the same class of work, not a capability that needs
   *  its own model knob. */
  async goal(task: string): Promise<void> {
    await this.runSideAgent(resolveRoleProfile(this.config, 'planner'), GOAL_AGENT_PROMPT, task, 'goal');
  }

  /** Runs the reviewer alone against the current workspace state — usable any
   *  time, independent of whether a task is mid-flight. */
  async review(instructions?: string): Promise<void> {
    const prompt = instructions
      ? `Review the current state of the workspace. ${instructions}`
      : 'Review the current state of the workspace for correctness, obvious bugs, or incomplete work.';
    await this.runSideAgent(resolveRoleProfile(this.config, 'reviewer'), REVIEWER_AGENT_PROMPT, prompt, 'review');
  }

  interrupt(): void {
    if (this.currentTask) this.steeringContext = this.currentTask;
    this.controller?.abort();
  }

  async clear(): Promise<string> {
    if (this.controller) {
      return 'A task is running — interrupt it before clearing.';
    }
    this.history.clear();
    this.steeringContext = null;
    this.pendingPlan = null;
    this.dedupeCache.clear();
    this.readFiles.clear();
    this.approvals.reset();

    // Background jobs go too. A clean slate that leaves a dev server running and
    // its completion queued would wake the agent up about work whose context has
    // just been deleted. `killAll` is deliberately silent, so nothing is queued
    // by this.
    const running = this.jobs.list().filter(j => j.status === 'running').length;
    this.jobs.killAll();
    this.pendingJobReports.length = 0;

    const notesDir = join(this.config.workspaceRoot, '.marshall', 'notes');
    let notesCleared = 0;
    if (existsSync(notesDir)) {
      const files = await readdir(notesDir);
      const notes = files.filter(f => f.endsWith('.md'));
      await Promise.all(notes.map(f => rm(join(notesDir, f), { force: true })));
      notesCleared = notes.length;
    }

    this.log('CLEAR');
    const extras = [
      ...(notesCleared > 0 ? [`${notesCleared} scratch note${notesCleared === 1 ? '' : 's'}`] : []),
      ...(running > 0 ? [`${running} background job${running === 1 ? '' : 's'}`] : []),
    ];
    const base = 'history, dedupe cache, always-approved list';
    return extras.length > 0
      ? `${base}, and ${extras.join(' and ')} cleared`
      : `${base} cleared`;
  }
}
