import { join, dirname } from 'node:path';
import { readFile, readdir, rm, appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { History, AgentEvent, BaseAgent, Tool, ToolResultEvent, webSearchTool } from '@agentionai/agents/core';
import type { BuiltInTool } from '@agentionai/agents/core';
import { toolResultMaskingPlugin, compressionPlugin } from '@agentionai/agents/history/plugins';
import type { ToolResultMaskingPlugin } from '@agentionai/agents/history/plugins';
import {
  createFileTools,
  createReadOnlyFileTools,
  createShellTool,
  createScratchTools,
  createGitHubTools,
  createJobTools,
  createDedupeCache,
  createBackgroundJobs,
  summariseJob,
  formatJobOutput,
} from '@agentionai/marshall-tools';
import type { ToolConfig, DedupeCache, BackgroundJob, BackgroundJobs } from '@agentionai/marshall-tools';
import type { ApprovalDecision, ApprovalRequest, ApprovalDecider, ApprovalFn } from '@agentionai/marshall-tools';
import { McpRegistry } from './mcp.js';
import type { McpServerConfig, McpServerState } from './mcp.js';
import {
  createAgent,
  buildSystemPrompt,
  CONTEXT_AGENT_PROMPT,
  SEARCH_AGENT_PROMPT,
  PLANNER_AGENT_PROMPT,
  GOAL_AGENT_PROMPT,
  REVIEWER_AGENT_PROMPT,
  CONTEXT_TOOL_GUIDANCE,
  SURVEY_TOOL_GUIDANCE,
  PLANNER_TOOL_GUIDANCE,
  REVIEWER_TOOL_GUIDANCE,
} from './agent-factory.js';
import { agentTool } from './agent-tool.js';
import { runAgent } from './streaming.js';
import { checkAttachments, buildInput } from './images.js';
import type { ImageAttachment } from './images.js';
import { describeAgentError, providerErrorDiagnostics, isBadRequestError, isContextLengthError } from './errors.js';
import { resolveRoleProfile, isDelegated, resolveModel, contextToolEnabled, routingSummary, resolveSearchProfile } from './config.js';
import type { EngineConfig, AgentProfile, Role } from './config.js';
import type { ClientInterface } from './types.js';

interface AgentWithUsage extends BaseAgent<string, string> {
  lastTokenUsage?: { input_tokens: number; output_tokens: number };
}

const NEVER_MASK_TOOLS = [
  'list_dir', 'note_write', 'note_read', 'note_list', 'log_append', 'log_read', 'context', 'search',
  // A job id is a handle the model needs later, and it only ever appears in the
  // result of the call that created it. Masking that away strands the job.
  'shell_list',
];

const DEFAULT_AUTO_RESUME_BUDGET = 4;

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

/**
 * Walk an approval chain until something has an opinion.
 *
 * Denies if every link defers. That can only happen if the chain is
 * misconfigured — the human link never defers — and on a gate whose whole job
 * is to withhold consent, the safe answer to "nobody decided" is no.
 */
async function runChain(chain: ApprovalDecider[], req: ApprovalRequest): Promise<ApprovalDecision> {
  for (const decide of chain) {
    const verdict = await decide(req);
    if (verdict !== 'defer') return verdict;
  }
  return 'deny';
}

/**
 * The text an assistant message carried alongside its tool calls.
 *
 * Anthropic sends text and tool_use blocks in one content array, so the prose
 * that led up to a call is right there. The chat-completions providers emit only
 * the tool calls on this event and stream their text separately, which is why
 * this returns '' for them rather than guessing.
 *
 * Exported for tests only — the provider shapes are the whole risk here, and
 * they are far cheaper to pin down directly than through a live agent.
 */
export function assistantText(content: unknown[]): string {
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      Boolean(block) && typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim();
}

export class Session {
  private readonly history: History;
  private readonly maskingPlugin: ToolResultMaskingPlugin;
  private readonly dedupeCache: DedupeCache;
  private readonly alwaysApproved = new Set<string>();
  /**
   * In-flight approval promises keyed by tool name. Parallel tool calls for the
   * same tool all run their approval gate at once, so without this, choosing
   * "always" only applies to whichever one reaches the makeApproval check first
   * — the rest still prompt. Coalescing them means one user decision answers
   * the whole batch.
   */
  private readonly pendingApprovals = new Map<string, Promise<ApprovalDecision>>();
  private readonly logPath: string;
  private readonly logDirReady: Promise<void>;
  private compressionReady = false;
  /** The plugin can only be added once — History has no removal. */
  private compressionRegistered = false;
  /** Token threshold once the summariser is live; null while compression is off. */
  private compressionThreshold: number | null = null;
  // Rebuilt by setProfiles, so not readonly: these four are the only things
  // besides the coder itself that are bound to a model, and the coder is
  // resolved fresh on every turn.
  private contextToolReady!: Promise<Tool<string> | null>;
  private searchToolReady!: Promise<Tool<string> | null>;
  private plannerToolReady!: Promise<Tool<string> | null>;
  private reviewerToolReady!: Promise<Tool<string> | null>;
  /**
   * The agent the compression plugin summarises with.
   *
   * Held in a field rather than captured by the plugin because `History.use`
   * has no counterpart — a plugin can be registered but never removed. So the
   * plugin is registered once with a stable delegate (see ensureCompression)
   * and a model switch swaps what sits behind it. Registering a second plugin
   * per switch would compound summarisation on every reduce.
   */
  private summaryAgent: BaseAgent<string, string> | null = null;
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
    this.jobs = createBackgroundJobs({ onExit: (job) => this.onJobExit(job) });
    this.autoResumeBudget = config.autoResumeBudget ?? DEFAULT_AUTO_RESUME_BUDGET;

    this.mcp = new McpRegistry(config.mcpServers);
    if (!this.mcp.isEmpty) void this.mcp.connectAll().then(() => this.reportMcpState());

    this.logPath = join(config.workspaceRoot, '.marshall', 'logs', 'session.log');
    this.logDirReady = mkdir(dirname(this.logPath), { recursive: true }).then(() => {});

    this.buildRoleTools();
    this.logTierRouting();
  }

  /**
   * Build every model-bound sub-agent tool from the current config.
   *
   * Called from the constructor and again on each model switch. The coder is
   * absent on purpose — `run` resolves its profile per turn, so it follows a
   * switch without help.
   */
  private buildRoleTools(): void {
    const config = this.config;

    // Light mode is single-agent by definition: every sub-agent tool costs a
    // schema in the prompt *and* a guidance block explaining when to delegate,
    // which is exactly the overhead light mode exists to remove. Nothing else
    // here needs a light branch — the four fields below are the only sub-agents.
    if (config.light) {
      this.contextToolReady = Promise.resolve(null);
      this.searchToolReady = Promise.resolve(null);
      this.plannerToolReady = Promise.resolve(null);
      this.reviewerToolReady = Promise.resolve(null);
      return;
    }

    // Every role's model comes from resolveRoleProfile, so a `fast` tier set via
    // /model actually routes work at run time. Enablement is a separate question
    // from which model runs it: the planner and reviewer stay opt-in because they
    // change how the agent behaves, not just what it costs — see contextToolEnabled.
    this.contextToolReady = contextToolEnabled(config)
      ? this.buildContextTool(resolveRoleProfile(config, 'context'))
      : Promise.resolve(null);

    // Web search rides Anthropic's server-side tool, so it only works on claude.
    // `search` defaults to the fast tier, which is exactly where someone puts a
    // local model — so honour the tier when it can search, and otherwise fall back
    // to deep rather than silently dropping the capability. Pointing a local fast
    // tier at llama.cpp should make search cost more, not disappear.
    const searchProfile = resolveSearchProfile(config);
    this.searchToolReady = config.enableWebSearch !== false && searchProfile !== null
      ? this.buildSearchTool(searchProfile)
      : Promise.resolve(null);

    this.plannerToolReady = config.plannerAgent
      ? this.buildReadOnlyAgentTool(resolveRoleProfile(config, 'planner'), {
          name: 'planner',
          systemPrompt: PLANNER_AGENT_PROMPT,
          description: 'Get a step-by-step plan for a coding task before starting. Provide the task description; returns an ordered list of concrete steps and files to touch.',
        })
      : Promise.resolve(null);

    this.reviewerToolReady = config.reviewerAgent
      ? this.buildReadOnlyAgentTool(resolveRoleProfile(config, 'reviewer'), {
          name: 'reviewer',
          systemPrompt: REVIEWER_AGENT_PROMPT,
          description: 'Get a second opinion on changes before finishing. Describe the task and what you changed; the reviewer reads the actual files and flags bugs or missed requirements.',
        })
      : Promise.resolve(null);
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
    this.buildRoleTools();
    // The plugin stays registered and keeps working; only the model behind it
    // changes. Rebuilt lazily so a switch costs nothing until history is big
    // enough to compress.
    this.summaryAgent = null;
    this.compressionReady = false;
    this.log(`PROFILES deep=${deep.provider}/${resolveModel(deep)}${fast ? ` fast=${fast.provider}/${resolveModel(fast)}` : ''}`);
    this.logTierRouting();
  }

  /**
   * Wraps `agentTool` with the engine's profile handling: the profile is
   * validated once up front, so an unusable one (missing key, unknown provider)
   * means the tool is absent rather than present and failing on every call.
   */
  private async buildAgentTool(opts: {
    name: string;
    description: string;
    profile: AgentProfile;
    systemPrompt: string;
    maxTokens?: number;
    /** Fresh tool belt per spawn — tools hold per-call state, so never shared. */
    makeTools?: () => Tool<unknown>[];
    builtInTools?: BuiltInTool[];
  }): Promise<Tool<string> | null> {
    const create = async (parent?: string) => {
      const tools = opts.makeTools?.() ?? [];
      const agent = await createAgent(opts.profile, tools, new History(), {
        maxTokens: opts.maxTokens ?? this.config.maxTokens,
        systemPrompt: opts.systemPrompt,
        name: opts.name,
        ...(opts.builtInTools ? { builtInTools: opts.builtInTools } : {}),
      });
      // Mirror the sub-agent's own reads to the transcript, tagged with the call
      // it belongs to. Otherwise a delegated survey is just a long pause. The
      // agent and its tools are discarded after the call, so these listeners go
      // with them — no detach needed.
      if (parent) this.attachSubAgentListeners(agent, tools, parent);
      return agent;
    };

    try {
      await create();
    } catch {
      return null;
    }

    const label = `${opts.profile.provider}/${resolveModel(opts.profile)}`;
    return agentTool({
      name: opts.name,
      description: opts.description,
      spawn: ({ id }) => create(`${opts.name}#${id}`),
      onStart: ({ id, instructions }) =>
        this.log(`SUBAGENT ${opts.name}#${id} START ${label} ${JSON.stringify(instructions.slice(0, 200))}`),
      onEnd: ({ id, ms, error, result }) => {
        this.log(
          `SUBAGENT ${opts.name}#${id} ${error ? 'ERROR' : 'DONE'} ${(ms / 1000).toFixed(1)}s ` +
          (error ?? `${String(result ?? '').length} chars`),
        );
        this.client.onOutput({
          type: 'subagent-done',
          label: `${opts.name}#${id}`,
          durationMs: ms,
          chars: String(result ?? '').length,
          ...(error ? { error } : {}),
        });
      },
    });
  }

  private buildContextTool(profile: AgentProfile): Promise<Tool<string> | null> {
    return this.buildAgentTool({
      name: 'context',
      description: 'Gather information from files and code in the workspace. Provide detailed instructions about what to look for. Safe to call several times in one turn — each call runs independently and in parallel.',
      profile,
      systemPrompt: CONTEXT_AGENT_PROMPT,
      makeTools: () => createReadOnlyFileTools(this.config.workspaceRoot, this.config.limits),
    });
  }

  /** Shared builder for the planner/reviewer sub-agents — both get read-only file
   *  access and their own isolated history, and differ only in prompt/tool name. */
  private buildReadOnlyAgentTool(
    profile: AgentProfile,
    opts: { name: string; systemPrompt: string; description: string },
  ): Promise<Tool<string> | null> {
    return this.buildAgentTool({
      name: opts.name,
      description: opts.description,
      profile,
      systemPrompt: opts.systemPrompt,
      makeTools: () => createReadOnlyFileTools(this.config.workspaceRoot, this.config.limits),
    });
  }

  /** Web search runs through its own sub-agent — search results are often large and
   *  noisy, so keeping them out of the main agent's context avoids burning its budget. */
  private buildSearchTool(profile: AgentProfile): Promise<Tool<string> | null> {
    return this.buildAgentTool({
      name: 'search',
      description: 'Search the web for current information. Provide a specific query and what you want to know.',
      profile,
      systemPrompt: SEARCH_AGENT_PROMPT,
      builtInTools: [webSearchTool({ maxUses: 5 })],
    });
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
    this.buildRoleTools();
    this.log(`LIGHT ${light ? 'on' : 'off'}`);
  }

  get hasPendingPlan(): boolean {
    return this.pendingPlan !== null;
  }

  /** Tool name → the role that backs it, for the "ran on the fast model" tag. */
  private static readonly TOOL_ROLES: Record<string, Role> = {
    context:  'context',
    search:   'search',
    planner:  'planner',
    reviewer: 'reviewer',
  };

  /**
   * Mirror a sub-agent's tool activity to the client. Returns a detach function;
   * without it the shared sub-agent tools accumulate a listener per invocation.
   */
  private attachToolListeners(
    agent: BaseAgent<string, string>,
    tools: Tool<unknown>[],
    signal: AbortSignal,
    /** Names the agent when it isn't the coder — /plan and /review call tools of
     *  their own, and unlabelled those rows read as the coder's work. */
    caller?: string,
  ): () => void {
    const tag = caller ? { caller } : {};
    const onToolResult = (event: InstanceType<typeof ToolResultEvent>) => {
      if (signal.aborted) return;
      const preview = String(event.result).slice(0, 500);
      this.client.onOutput({ type: 'tool-result', toolName: event.target.name, result: preview });
    };
    for (const tool of tools) tool.on(ToolResultEvent.RESULT, onToolResult);

    agent.on(AgentEvent.TOOL_USE, (content: unknown) => {
      if (signal.aborted) return;
      if (!Array.isArray(content)) return;
      // Announced before the calls it introduces, so the transcript keeps the
      // order the model wrote them in.
      const said = assistantText(content);
      if (said) this.client.onOutput({ type: 'assistant', text: said });
      for (const block of content) {
        if (!block || typeof block !== 'object' || !('type' in block)) continue;
        if (block.type === 'tool_use') {
          const b = block as { name: string; input: unknown };
          this.client.onOutput({ type: 'tool-call', toolName: b.name, input: b.input, subagent: this.subagentInfo(b.name), ...tag });
          this.log(`TOOL_CALL ${caller ?? 'coder'} ${b.name} ${JSON.stringify(b.input ?? {}).slice(0, 200)}`);
        } else if (block.type === 'function' && 'function' in block) {
          const b = block as { function: { name: string; arguments: string } };
          let input: unknown;
          try { input = JSON.parse(b.function.arguments); } catch { input = b.function.arguments; }
          this.client.onOutput({ type: 'tool-call', toolName: b.function.name, input, subagent: this.subagentInfo(b.function.name), ...tag });
          this.log(`TOOL_CALL ${caller ?? 'coder'} ${b.function.name} ${b.function.arguments.slice(0, 200)}`);
        }
      }
    });

    return () => { for (const tool of tools) tool.off(ToolResultEvent.RESULT, onToolResult); };
  }

  /**
   * Mirror a spawned sub-agent's tool activity, tagged with `parent` so the
   * client can nest it under the call that owns it — and so several fanned-out
   * agents stay distinguishable while their output interleaves.
   */
  private attachSubAgentListeners(
    agent: BaseAgent<string, string>,
    tools: Tool<unknown>[],
    parent: string,
  ): void {
    for (const tool of tools) {
      tool.on(ToolResultEvent.RESULT, (event: InstanceType<typeof ToolResultEvent>) => {
        this.client.onOutput({
          type: 'tool-result',
          toolName: event.target.name,
          result: String(event.result).slice(0, 300),
          parent,
        });
      });
    }

    agent.on(AgentEvent.TOOL_USE, (content: unknown) => {
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (!block || typeof block !== 'object' || !('type' in block)) continue;
        if (block.type === 'tool_use') {
          const b = block as { name: string; input: unknown };
          this.client.onOutput({ type: 'tool-call', toolName: b.name, input: b.input, parent });
        } else if (block.type === 'function' && 'function' in block) {
          const b = block as { function: { name: string; arguments: string } };
          let input: unknown;
          try { input = JSON.parse(b.function.arguments); } catch { input = b.function.arguments; }
          this.client.onOutput({ type: 'tool-call', toolName: b.function.name, input, parent });
        }
      }
    });
  }

  /**
   * Describes an agent-backed tool, or undefined for an ordinary one.
   *
   * Reported for *every* agent-backed tool, not only the delegated ones: the
   * fact that work was handed to another agent is worth showing even when it
   * happens to run on the same model. `delegated` carries the tier distinction
   * separately.
   */
  private subagentInfo(toolName: string): { model: string; delegated: boolean } | undefined {
    const role = Session.TOOL_ROLES[toolName];
    if (!role) return undefined;
    const profile = resolveRoleProfile(this.config, role);
    return {
      model: `${profile.provider}/${resolveModel(profile)}`,
      delegated: isDelegated(this.config, role),
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

  private async ensureCompression(): Promise<void> {
    if (this.compressionReady) return;
    this.compressionReady = true;

    const threshold = this.config.compressionThreshold ?? 40_000;
    if (threshold === 0) return;

    const summaryProfile = resolveRoleProfile(this.config, 'summarizer');
    try {
      // `transient: true` is the whole point: it makes every provider's
      // execute() clear this History before each call (see BaseAgent's own
      // doc comment on the `history` param). Without it, the *same* agent
      // instance is reused for every compression in the session — proactive
      // and reactive alike — and each call would otherwise append its prompt
      // and summary onto the last one's, so the summariser's own
      // conversation grows without bound. On a setup with no distinct fast
      // tier the summariser is the same small-context model that keeps
      // failing, so a few compressions in, it starts failing on its *own*
      // accumulated history — the exact problem it exists to fix.
      this.summaryAgent = await createAgent(summaryProfile, [], new History([], { transient: true }), { maxTokens: 1024 });
      this.compressionThreshold = threshold;
      this.log(`COMPRESSION_READY summariser=${summaryProfile.provider}/${resolveModel(summaryProfile)} threshold=${threshold}`);
    } catch (err) {
      // Skip compression if the summariser can't be created. Left registered:
      // a later switch to a reachable model makes it work again. `compressionReady`
      // is already true at this point, so without this log a failed creation here
      // disables compression for the rest of the session with no visible trace.
      this.log(`COMPRESSION_UNAVAILABLE summariser=${summaryProfile.provider}/${resolveModel(summaryProfile)} ${describeAgentError('summarizer', summaryProfile, err)} details=${providerErrorDiagnostics(err)}`);
      return;
    }

    if (this.compressionRegistered) return;
    this.compressionRegistered = true;

    // Registered *without* `autoReduceWhen` on purpose. That option makes the
    // plugin call `void history.reduce(...)` from afterAdd — fire-and-forget,
    // no catch — so a summariser failure (its server going away, say) became an
    // unhandled rejection and killed the process. Driving reduction ourselves
    // from compressIfNeeded() keeps it awaited, catchable, and non-fatal.
    //
    // The plugin gets a delegate rather than the agent itself, because History
    // has no way to unregister a plugin: registering a fresh one per model
    // switch would stack them and compound the summary on every reduce. The
    // delegate resolves `this.summaryAgent` at call time, so a switch is a
    // field assignment.
    this.history.use(compressionPlugin({
      execute: (prompt: string) => {
        const agent = this.summaryAgent;
        if (!agent) throw new Error('no summariser is configured');
        return agent.execute(prompt);
      },
    } as unknown as BaseAgent<string, string>));
  }

  /**
   * Upper bound on how much a single `history.reduce()` call is allowed to
   * fold into the summariser's prompt.
   *
   * The summariser role has no dedicated cheap model on most local setups —
   * `resolveRoleProfile('summarizer')` degrades to the same profile as the
   * coder when the provider has no cheap alternative (llama.cpp, Ollama). So
   * a summariser prompt shares the exact context window that just overflowed.
   * Jumping straight from, say, 30k tokens of history to a 5k target hands the
   * summariser the entire 25k-token gap in one prompt, which blows the same
   * limit it exists to fix. Reducing in small steps keeps each individual
   * summarisation prompt well under any local server's context window,
   * regardless of how far over budget history has grown.
   */
  private static readonly COMPRESSION_STEP_TOKENS = 3_000;

  /**
   * Shrink history toward `target`, one bounded step at a time — see
   * `COMPRESSION_STEP_TOKENS`. Stops early if a step makes no progress
   * (summariser returned something no smaller) rather than spinning forever.
   */
  private async reduceToTarget(target: number): Promise<void> {
    if (this.history.totalEstimatedTokens <= target) {
      this.log(`REDUCE_SKIPPED current=${this.history.totalEstimatedTokens} target=${target} — already at or under target`);
      return;
    }
    let step = 0;
    while (this.history.totalEstimatedTokens > target) {
      step += 1;
      const before = this.history.totalEstimatedTokens;
      const stepTarget = Math.max(target, before - Session.COMPRESSION_STEP_TOKENS);
      this.log(`REDUCE_STEP #${step} before=${before} stepTarget=${stepTarget} finalTarget=${target}`);
      await this.history.reduce({ maxTokens: stepTarget });
      const after = this.history.totalEstimatedTokens;
      this.log(`REDUCE_STEP #${step} after=${after}`);
      if (after >= before) {
        this.log(`REDUCE_STOPPED #${step} made no progress (before=${before} after=${after})`);
        break;
      }
    }
  }

  /**
   * Compress history when it has outgrown the threshold. Best-effort: if the
   * summariser is unreachable we log and carry on with an uncompressed history,
   * because failing to shrink the context is not a reason to fail the task.
   */
  private async compressIfNeeded(): Promise<void> {
    const threshold = this.compressionThreshold;
    if (threshold === null) return;
    if (this.history.totalEstimatedTokens < threshold) return;

    try {
      await this.reduceToTarget(threshold);
      this.log(`COMPRESSED to ~${this.history.totalEstimatedTokens} tokens`);
    } catch (err) {
      const profile = resolveRoleProfile(this.config, 'summarizer');
      this.log(`COMPRESSION_FAILED ${describeAgentError('summarizer', profile, err)} details=${providerErrorDiagnostics(err)}`);
    }
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

  /**
   * Extra room to cut beyond the measured overage — the retry adds a fresh
   * copy of the current turn on top of whatever's left, so trimming to an
   * exact fit just fails again.
   */
  private static readonly CONTEXT_ERROR_MARGIN = 1_024;

  /**
   * How far to shrink history for a context-overflow retry.
   *
   * llama.cpp's message names both numbers — how big the rejected request
   * was, and how much room the server actually has — which lets the cut be
   * sized to the *measured* overage instead of a flat fraction of the context
   * window. That distinction matters most exactly when the overage is small:
   * history can already sit well under any fixed percentage of `available`
   * while still being, say, 900 tokens too big. A percentage-based target
   * then lands *above* `current`, and `reduceToTarget`'s `totalEstimatedTokens
   * > target` loop never runs at all — no compression attempted, no log line,
   * and the original error goes straight back to the user.
   *
   * Other providers' wording isn't parsed yet, so they fall back to the
   * percentage heuristic.
   */
  private contextErrorTarget(message: string, current: number): number {
    const overflow = /request\s*\((\d+)\s*tokens?\)\s*exceeds the available context size\s*\((\d+)\s*tokens?\)/i.exec(message);
    if (overflow) {
      const requestTokens = Number(overflow[1]);
      const availableTokens = Number(overflow[2]);
      const overage = requestTokens - availableTokens;
      const target = Math.max(0, current - overage - Session.CONTEXT_ERROR_MARGIN);
      this.log(`CONTEXT_ERROR_TARGET_METHOD measured requestTokens=${requestTokens} availableTokens=${availableTokens} overage=${overage} -> target=${target}`);
      return target;
    }

    const available = /available context size\s*\((\d+)\s*tokens?\)/i.exec(message)?.[1];
    const target = available
      ? Math.max(1_024, Math.floor(Number(available) * 0.4))
      : Math.max(1_024, Math.floor(current * 0.4));
    this.log(`CONTEXT_ERROR_TARGET_METHOD fallback available=${available ?? 'unknown'} current=${current} -> target=${target}`);
    return target;
  }

  private async compressForContextError(message: string): Promise<boolean> {
    this.log(`CONTEXT_ERROR_COMPRESS_START ${JSON.stringify(message)}`);

    if (!this.summaryAgent) await this.ensureCompression();
    if (!this.summaryAgent) {
      this.log('CONTEXT_ERROR_COMPRESS_ABORTED no summariser available (see COMPRESSION_UNAVAILABLE above, or compressionThreshold: 0)');
      return false;
    }

    const current = this.history.totalEstimatedTokens;
    // Even when history already looks "small enough", it may still be the
    // biggest lever we have — the overflow can equally come from tools/system
    // prompt, which compression can never touch. Only skip when there is
    // nothing left to compress at all.
    if (current === 0) {
      this.log('CONTEXT_ERROR_COMPRESS_ABORTED history is empty — nothing to compress');
      return false;
    }

    const target = this.contextErrorTarget(message, current);
    this.log(`CONTEXT_ERROR_COMPRESS_TARGET current=${current} target=${target}`);

    try {
      await this.reduceToTarget(target);
    } catch (err) {
      const profile = resolveRoleProfile(this.config, 'summarizer');
      this.log(`COMPRESSION_FAILED ${describeAgentError('summarizer', profile, err)} details=${providerErrorDiagnostics(err)}`);
    }
    // Report progress even if a later step in reduceToTarget threw — partial
    // compression from the steps that succeeded before the failure can still be
    // enough to let the retry through.
    const after = this.history.totalEstimatedTokens;
    const reduced = after < current;
    this.log(`CONTEXT_ERROR_COMPRESSED current=${current} after=${after} reduced=${reduced}`);
    return reduced;
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
   * The ordered chain that answers an approval request.
   *
   * Each decider returns a decision or `'defer'`, and the first non-defer wins;
   * asking the human is simply the last link, the one that never defers. Written
   * as a chain rather than an `if` ladder because the intended next entry is an
   * agent that judges a request and only escalates the risky ones — it slots in
   * between these two, and no tool has to know it exists. That is also why
   * ApprovalRequest carries structured `input` and `source`: a reviewer needs
   * the arguments and the provenance, not the prose meant for a human.
   */
  private approvalChain(): ApprovalDecider[] {
    return [
      // Session "always allow", by tool name.
      async (req) => {
        if (!this.alwaysApproved.has(req.toolName)) return 'defer';
        this.log(`TOOL ${req.toolName} auto-approved (always)`);
        return 'approve';
      },
      // ── an automated reviewer would go here ──
      (req) => this.decideApproval(req),
    ];
  }

  /** Approval function that honours the per-session always-approve list. */
  private makeApproval(): ApprovalFn {
    const chain = this.approvalChain();
    return async (req) => {
      // Parallel tool calls for the same tool all reach this gate at once, so a
      // single user decision should answer the whole batch — otherwise choosing
      // "always" only sticks for whichever call happens to resolve first and the
      // rest still prompt. Coalesce them onto one shared decision.
      const inFlight = this.pendingApprovals.get(req.toolName);
      if (inFlight) return inFlight;

      const decision = runChain(chain, req);
      this.pendingApprovals.set(req.toolName, decision);
      void decision.finally(() => this.pendingApprovals.delete(req.toolName));
      return decision;
    };
  }

  private async decideApproval(req: ApprovalRequest): Promise<ApprovalDecision> {
    const decision = await this.client.requestApproval(req);
    if (decision === 'always') {
      this.alwaysApproved.add(req.toolName);
      this.log(`TOOL ${req.toolName} approved (always — added to session list)`);
    } else {
      this.log(`TOOL ${req.toolName} ${decision === 'approve' ? 'approved' : 'denied'}`);
    }
    return decision;
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
    const [, contextTool, searchTool, plannerTool, reviewerTool] = await Promise.all([
      this.ensureCompression(),
      this.contextToolReady,
      this.searchToolReady,
      this.plannerToolReady,
      this.reviewerToolReady,
      // Settles whether the servers connected or failed, so a dead server costs
      // this turn a bounded wait rather than dropping its tools without a word.
      this.mcp.ready(),
    ]);

    // Shrink before the turn rather than mid-turn: the plugin's own trigger was
    // the unhandled-rejection crash, and doing it here keeps it awaited.
    await this.compressIfNeeded();

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
    const startMs = Date.now();

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

      const toolConfig: ToolConfig = {
        workspaceRoot: this.config.workspaceRoot,
        approval: this.makeApproval(),
        signal,
        commandPolicy: this.config.commandPolicy,
        limits: this.config.limits,
        // Every gated action names its author in the prompt. Only the coder has
        // write tools today, but "who is asking me to approve this" should be
        // answered on the panel rather than assumed.
        caller: { role: 'coder', model: `${coderProfile.provider}/${resolveModel(coderProfile)}` },
        // Withholding the registry is what removes `background` from run_shell's
        // schema — the factory keys the option off its presence, so light mode
        // does not need the shell tool to know it exists.
        ...(light ? {} : { jobs: this.jobs }),
      };

      const tools = [
        ...createFileTools(toolConfig, this.dedupeCache),
        createShellTool(toolConfig),
        ...(light ? [] : createJobTools(toolConfig)),
        ...(light ? [] : createScratchTools(toolConfig)),
        ...(this.config.enableGitHub ? createGitHubTools(toolConfig) : []),
        ...(contextTool ? [contextTool] : []),
        ...(searchTool ? [searchTool] : []),
        ...(plannerTool ? [plannerTool] : []),
        ...(reviewerTool ? [reviewerTool] : []),
        // Rebuilt per turn: the wrapping binds this turn's approval fn, abort
        // signal and caller identity, none of which outlive the turn.
        ...this.mcp.tools(toolConfig),
        this.maskingPlugin.retrieveTool,
      ];


      const extraInstructions = [
        contextTool ? CONTEXT_TOOL_GUIDANCE : '',
        plannerTool ? PLANNER_TOOL_GUIDANCE : '',
        reviewerTool ? REVIEWER_TOOL_GUIDANCE : '',
      ].join('');

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
      }) as AgentWithUsage;
      if (coderProfile.provider === 'llamacpp') this.llamaModelLoaded = true;

      // Shared with /plan and /review. The per-run file/shell tools die with the
      // run, but the context/search/planner/reviewer tools and the masking
      // plugin's retrieve tool are built once and shared by every run — without
      // the detach in `finally` each turn stacks another listener on those five.
      detachToolResult = this.attachToolListeners(agent, tools, signal);

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
        const compressed = await this.compressForContextError(message);
        this.log(`CONTEXT_ERROR_HANDED_BACK compressed=${compressed}`);
        this.steeringContext = task;
        this.client.onOutput({ type: 'context-full', compressed });
        return;
      }

      const durationMs = Date.now() - startMs;
      const usage = agent.lastTokenUsage;

      // Answer first, then the tally: the usage line accounts for the turn, so
      // it reads as a footer under the answer rather than a header above it.
      this.client.onOutput({ type: 'response', text: response });

      if (usage) {
        this.client.onOutput({
          type: 'usage',
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          durationMs,
        });
        this.log(`DONE ↑${usage.input_tokens} ↓${usage.output_tokens} tokens ${(durationMs / 1000).toFixed(1)}s`);
      }
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
      this.currentTask = null;
      this.controller = null;
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
      const contextTool = await this.contextToolReady;
      const tools = [
        ...createReadOnlyFileTools(this.config.workspaceRoot, this.config.limits),
        ...(contextTool ? [contextTool] : []),
      ];
      const agent = await createAgent(profile, tools, new History(), {
        // No cap unless one is configured — a whole-codebase review legitimately
        // runs long, and a fixed ceiling turns that into an error instead of an
        // answer. See resolveMaxTokens.
        maxTokens: this.config.maxTokens,
        systemPrompt,
        extraInstructions: contextTool ? SURVEY_TOOL_GUIDANCE : undefined,
        name: eventType,
      }) as AgentWithUsage;

      // /plan and /review used to run completely silently — no tool calls, no
      // results — so a long review looked like a hang. Tagged with the agent
      // that made them, since these rows sit at the same level as the coder's.
      detach = this.attachToolListeners(agent, tools, signal, eventType);

      this.client.onOutput({ type: 'thinking' });
      const text = await agent.execute(prompt);

      const durationMs = Date.now() - startMs;
      const usage = agent.lastTokenUsage;

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

      // After the result, for the same reason as in run().
      if (usage) {
        this.client.onOutput({
          type: 'usage',
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          durationMs,
        });
      }
      this.log(`${eventType.toUpperCase()}_DONE ${(durationMs / 1000).toFixed(1)}s`);
    } catch (err) {
      const message = describeAgentError(eventType, profile, err);
      this.log(`ERROR ${message}`);
      this.client.onOutput({ type: 'error', message });
    } finally {
      detach?.();
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
    this.alwaysApproved.clear();
    this.pendingApprovals.clear();

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
