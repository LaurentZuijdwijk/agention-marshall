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
  createDedupeCache,
} from '@agentionai/marshall-tools';
import type { ToolConfig, DedupeCache } from '@agentionai/marshall-tools';
import type { ApprovalDecision, ApprovalRequest } from '@agentionai/marshall-tools';
import {
  createAgent,
  CONTEXT_AGENT_PROMPT,
  SEARCH_AGENT_PROMPT,
  PLANNER_AGENT_PROMPT,
  REVIEWER_AGENT_PROMPT,
  CONTEXT_TOOL_GUIDANCE,
  SURVEY_TOOL_GUIDANCE,
  PLANNER_TOOL_GUIDANCE,
  REVIEWER_TOOL_GUIDANCE,
} from './agent-factory.js';
import { agentTool } from './agent-tool.js';
import { runAgent } from './streaming.js';
import { describeAgentError } from './errors.js';
import { resolveRoleProfile, isDelegated, resolveModel, contextToolEnabled, routingSummary, resolveSearchProfile } from './config.js';
import type { EngineConfig, AgentProfile, Role } from './config.js';
import type { ClientInterface } from './types.js';

interface AgentWithUsage extends BaseAgent<string, string> {
  lastTokenUsage?: { input_tokens: number; output_tokens: number };
}

const NEVER_MASK_TOOLS = [
  'list_dir', 'note_write', 'note_read', 'note_list', 'log_append', 'log_read', 'context', 'search',
];

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
  /** Token threshold once the summariser is live; null while compression is off. */
  private compressionThreshold: number | null = null;
  private readonly contextToolReady: Promise<Tool<string> | null>;
  private readonly searchToolReady: Promise<Tool<string> | null>;
  private readonly plannerToolReady: Promise<Tool<string> | null>;
  private readonly reviewerToolReady: Promise<Tool<string> | null>;
  private controller: AbortController | null = null;
  private currentTask: string | null = null;
  private steeringContext: string | null = null;
  private pendingPlan: string | null = null;

  constructor(
    private readonly config: EngineConfig,
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

    this.logPath = join(config.workspaceRoot, '.marshall', 'logs', 'session.log');
    this.logDirReady = mkdir(dirname(this.logPath), { recursive: true }).then(() => {});

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
    this.log(`TIERS ${summary} search=${searchLabel}`);
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
      const summaryAgent = await createAgent(summaryProfile, [], new History(), { maxTokens: 1024 });
      // Registered *without* `autoReduceWhen` on purpose. That option makes the
      // plugin call `void history.reduce(...)` from afterAdd — fire-and-forget,
      // no catch — so a summariser failure (its server going away, say) became an
      // unhandled rejection and killed the process. Driving reduction ourselves
      // from compressIfNeeded() keeps it awaited, catchable, and non-fatal.
      this.history.use(compressionPlugin(summaryAgent));
      this.compressionThreshold = threshold;
    } catch { /* skip compression if summariser can't be created */ }
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
      await this.history.reduce({ maxTokens: threshold });
      this.log(`COMPRESSED to ~${this.history.totalEstimatedTokens} tokens`);
    } catch (err) {
      const profile = resolveRoleProfile(this.config, 'summarizer');
      this.log(`COMPRESSION_FAILED ${describeAgentError('summarizer', profile, err)}`);
    }
  }

  /** Approval function that honours the per-session always-approve list. */
  private makeApproval(): (req: ApprovalRequest) => Promise<ApprovalDecision> {
    return async (req) => {
      if (this.alwaysApproved.has(req.toolName)) {
        this.log(`TOOL ${req.toolName} auto-approved (always)`);
        return 'approve';
      }
      // Parallel tool calls for the same tool all reach this gate at once, so a
      // single user decision should answer the whole batch — otherwise choosing
      // "always" only sticks for whichever call happens to resolve first and the
      // rest still prompt. Coalesce them onto one shared decision.
      const inFlight = this.pendingApprovals.get(req.toolName);
      if (inFlight) return inFlight;
      const decision = this.decideApproval(req);
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

  async run(task: string): Promise<void> {
    if (this.controller) {
      this.client.onOutput({ type: 'error', message: 'A task is already running.' });
      return;
    }

    this.controller = new AbortController();
    const [, contextTool, searchTool, plannerTool, reviewerTool] = await Promise.all([
      this.ensureCompression(),
      this.contextToolReady,
      this.searchToolReady,
      this.plannerToolReady,
      this.reviewerToolReady,
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
    this.pendingPlan = null;

    const effectiveTask = steering
      ? `[Previous task was interrupted: "${steering}"]\n\nNew direction: ${task}`
      : plan
      ? `[Plan]\n${plan}\n\n[Task]\n${task}`
      : task;

    this.currentTask = task;
    let errorReported = false;
    let detachToolResult: (() => void) | null = null;
    const startMs = Date.now();

    this.log(`TASK ${JSON.stringify(task)}`);

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
      };

      const tools = [
        ...createFileTools(toolConfig, this.dedupeCache),
        createShellTool(toolConfig),
        ...createScratchTools(toolConfig),
        ...(this.config.enableGitHub ? createGitHubTools(toolConfig) : []),
        ...(contextTool ? [contextTool] : []),
        ...(searchTool ? [searchTool] : []),
        ...(plannerTool ? [plannerTool] : []),
        ...(reviewerTool ? [reviewerTool] : []),
        this.maskingPlugin.retrieveTool,
      ];


      const extraInstructions = [
        contextTool ? CONTEXT_TOOL_GUIDANCE : '',
        plannerTool ? PLANNER_TOOL_GUIDANCE : '',
        reviewerTool ? REVIEWER_TOOL_GUIDANCE : '',
      ].join('');

      const agent = await createAgent(coderProfile, tools, this.history, {
        maxTokens: this.config.maxTokens,
        projectMemory: projectMemory || undefined,
        extraInstructions: extraInstructions || undefined,
      }) as AgentWithUsage;

      // Shared with /plan and /review. The per-run file/shell tools die with the
      // run, but the context/search/planner/reviewer tools and the masking
      // plugin's retrieve tool are built once and shared by every run — without
      // the detach in `finally` each turn stacks another listener on those five.
      detachToolResult = this.attachToolListeners(agent, tools, signal);

      agent.on(AgentEvent.ERROR, (err: unknown) => {
        if (signal.aborted) return;
        errorReported = true;
        const message = err instanceof Error ? err.message : String(err);
        this.client.onOutput({ type: 'error', message });
        this.log(`ERROR ${message}`);
      });

      this.client.onOutput({ type: 'thinking' });
      // Race instead of a plain await: the agent SDK has no cancellation hook, so
      // the run itself won't reject on abort — without this race, Esc would
      // do nothing until the model's current turn (and any tool-blocked retries it
      // attempts afterward) finished on its own, which can take minutes on local models.
      const response = await new Promise<string>((resolve, reject) => {
        runAgent(agent, effectiveTask, chunk => {
          if (signal.aborted) return;
          this.client.onOutput(chunk.type === 'reasoning'
            ? { type: 'reasoning', text: chunk.content }
            : { type: 'token', text: chunk.content });
        }).then(resolve, reject);
        signal.addEventListener('abort', () => {
          reject(new DOMException('Task interrupted by user', 'AbortError'));
        }, { once: true });
      });

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
        this.log(`ERROR ${message}`);
        this.client.onOutput({ type: 'error', message });
      }
    } finally {
      detachToolResult?.();
      this.currentTask = null;
      this.controller = null;
    }
  }

  /** Shared runner for /plan and /review — a one-shot, read-only sub-agent call
   *  that doesn't touch the main coder's history or tools. */
  private async runSideAgent(
    profile: AgentProfile,
    systemPrompt: string,
    prompt: string,
    eventType: 'plan' | 'review',
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
      // /plan and /review are broad by nature — "review the CLI" means reading a
      // whole subtree. Without the context tool the deep model does all of that
      // reading itself, at deep-model prices, which is exactly what the fast tier
      // exists to avoid. Handing it the same tool the coder gets lets it fan the
      // survey out and reason over the summaries instead.
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

      if (eventType === 'plan') this.pendingPlan = text;
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
    }
  }

  /** Runs the planner alone (no edits) and holds the result to prepend as
   *  context onto the next run() call — lets the user see/approve the plan
   *  before any code changes happen. */
  async plan(task: string): Promise<void> {
    await this.runSideAgent(resolveRoleProfile(this.config, 'planner'), PLANNER_AGENT_PROMPT, task, 'plan');
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

    const notesDir = join(this.config.workspaceRoot, '.marshall', 'notes');
    let notesCleared = 0;
    if (existsSync(notesDir)) {
      const files = await readdir(notesDir);
      const notes = files.filter(f => f.endsWith('.md'));
      await Promise.all(notes.map(f => rm(join(notesDir, f), { force: true })));
      notesCleared = notes.length;
    }

    this.log('CLEAR');
    return notesCleared > 0
      ? `history, dedupe cache, always-approved list, and ${notesCleared} scratch note${notesCleared === 1 ? '' : 's'} cleared`
      : 'history, dedupe cache, and always-approved list cleared';
  }
}
