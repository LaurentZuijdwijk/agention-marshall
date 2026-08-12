import { History, webSearchTool } from '@agentionai/agents/core';
import type { BuiltInTool, Tool } from '@agentionai/agents/core';
import type { ToolResultMaskingPlugin } from '@agentionai/agents/history/plugins';
import {
  createFileTools,
  createReadOnlyFileTools,
  createShellTool,
  createScratchTools,
  createGitHubTools,
  createJobTools,
  createAskTool,
} from '@agentionai/marshall-tools';
import type { ToolConfig, DedupeCache, BackgroundJobs, ApprovalFn, KeyedLock } from '@agentionai/marshall-tools';
import {
  createAgent,
  CONTEXT_AGENT_PROMPT,
  SEARCH_AGENT_PROMPT,
  PLANNER_AGENT_PROMPT,
  REVIEWER_AGENT_PROMPT,
  CONTEXT_TOOL_GUIDANCE,
  PLANNER_TOOL_GUIDANCE,
  REVIEWER_TOOL_GUIDANCE,
} from './agent-factory.js';
import { agentTool } from './agent-tool.js';
import { McpRegistry } from './mcp.js';
import { resolveRoleProfile, resolveModel, contextToolEnabled, resolveSearchProfile } from './config.js';
import type { EngineConfig, AgentProfile, Role } from './config.js';
import type { UsageTally } from './usage.js';
import type { SessionEvents } from './session-events.js';
import type { ClientInterface } from './types.js';

/**
 * What tools a turn has, and which model runs each one.
 *
 * Two lifetimes live here, which is why they share a module: the four
 * agent-backed sub-agent tools are bound to a *model* and so are rebuilt only on
 * a profile switch, while the file/shell/MCP belt is bound to a *turn* and is
 * rebuilt every time, because it carries that turn's approval gate, abort signal
 * and caller identity. Getting those two confused is how a tool outlives the
 * signal it was supposed to be cancelled by.
 */

/** The four model-bound sub-agent tools, once they have settled. */
export interface RoleTools {
  context: Tool<string> | null;
  search: Tool<string> | null;
  planner: Tool<string> | null;
  reviewer: Tool<string> | null;
}

/** Everything a turn needs handed to `createAgent`, built from the belt below. */
export interface TurnBelt {
  tools: Tool<unknown>[];
  /** Guidance blocks for exactly the sub-agent tools that actually resolved. */
  extraInstructions: string;
}

export interface ToolBeltDeps {
  /** A getter, not a value: the session replaces its config on every switch. */
  getConfig: () => EngineConfig;
  client: ClientInterface;
  log: (line: string) => void;
  /** Sub-agent spawns mirror their tool activity through this. */
  events: SessionEvents;
  approval: ApprovalFn;
  jobs: BackgroundJobs;
  /** Where each delegated call's token spend is recorded. */
  usage: UsageTally;
  /** Session-scoped read tracking — see ToolConfig.readFiles. */
  readFiles: Map<string, string>;
  /** Session-scoped per-path write lock — see ToolConfig.fileLock. */
  fileLock: KeyedLock;
  dedupeCache: DedupeCache;
  maskingPlugin: ToolResultMaskingPlugin;
  mcp: McpRegistry;
}

export class ToolBelt {
  // Rebuilt by `rebuildRoleTools`, so not readonly: these four are the only
  // things besides the coder itself that are bound to a model, and the coder is
  // resolved fresh on every turn.
  private contextReady!: Promise<Tool<string> | null>;
  private searchReady!: Promise<Tool<string> | null>;
  private plannerReady!: Promise<Tool<string> | null>;
  private reviewerReady!: Promise<Tool<string> | null>;
  /** Distinguishes every delegated call the session ever makes — see `onEnd`. */
  private subagentSeq = 0;

  constructor(private readonly deps: ToolBeltDeps) {
    this.rebuildRoleTools();
  }

  /**
   * Build every model-bound sub-agent tool from the current config.
   *
   * Called from the constructor and again on each model switch. The coder is
   * absent on purpose — `run` resolves its profile per turn, so it follows a
   * switch without help.
   */
  rebuildRoleTools(): void {
    const config = this.deps.getConfig();

    // Light mode is single-agent by definition: every sub-agent tool costs a
    // schema in the prompt *and* a guidance block explaining when to delegate,
    // which is exactly the overhead light mode exists to remove. Nothing else
    // here needs a light branch — the four fields below are the only sub-agents.
    if (config.light) {
      this.contextReady = Promise.resolve(null);
      this.searchReady = Promise.resolve(null);
      this.plannerReady = Promise.resolve(null);
      this.reviewerReady = Promise.resolve(null);
      return;
    }

    // Every role's model comes from resolveRoleProfile, so a `fast` tier set via
    // /model actually routes work at run time. Enablement is a separate question
    // from which model runs it: the planner and reviewer stay opt-in because they
    // change how the agent behaves, not just what it costs — see contextToolEnabled.
    this.contextReady = contextToolEnabled(config)
      ? this.buildContextTool(resolveRoleProfile(config, 'context'))
      : Promise.resolve(null);

    // Web search rides Anthropic's server-side tool, so it only works on claude.
    // `search` defaults to the fast tier, which is exactly where someone puts a
    // local model — so honour the tier when it can search, and otherwise fall back
    // to deep rather than silently dropping the capability. Pointing a local fast
    // tier at llama.cpp should make search cost more, not disappear.
    const searchProfile = resolveSearchProfile(config);
    this.searchReady = config.enableWebSearch !== false && searchProfile !== null
      ? this.buildSearchTool(searchProfile)
      : Promise.resolve(null);

    this.plannerReady = config.plannerAgent
      ? this.buildReadOnlyAgentTool(resolveRoleProfile(config, 'planner'), {
          name: 'planner',
          role: 'planner',
          systemPrompt: PLANNER_AGENT_PROMPT,
          description: 'Get a step-by-step plan for a coding task before starting. Provide the task description; returns an ordered list of concrete steps and files to touch.',
        })
      : Promise.resolve(null);

    this.reviewerReady = config.reviewerAgent
      ? this.buildReadOnlyAgentTool(resolveRoleProfile(config, 'reviewer'), {
          name: 'reviewer',
          role: 'reviewer',
          systemPrompt: REVIEWER_AGENT_PROMPT,
          description: 'Get a second opinion on changes before finishing. Describe the task and what you changed; the reviewer reads the actual files and flags bugs or missed requirements.',
        })
      : Promise.resolve(null);
  }

  /**
   * Just the context tool. `/plan`, `/goal` and `/review` share it and should
   * not wait on the planner/reviewer/search agents settling — an unreachable
   * model among those costs a connection timeout before it resolves to null.
   */
  contextTool(): Promise<Tool<string> | null> {
    return this.contextReady;
  }

  /** Settles every sub-agent tool. A turn awaits this before building its belt. */
  async ready(): Promise<RoleTools> {
    const [context, search, planner, reviewer] = await Promise.all([
      this.contextReady, this.searchReady, this.plannerReady, this.reviewerReady,
    ]);
    return { context, search, planner, reviewer };
  }

  /**
   * The belt for one turn: file/shell/job/MCP tools bound to this turn's
   * approval gate, abort signal and caller identity, plus whichever sub-agent
   * tools resolved.
   */
  forTurn(opts: {
    signal: AbortSignal;
    /** The user's instruction, so a reviewer can judge scope — see ToolConfig. */
    taskContext: string;
    coderProfile: AgentProfile;
    roleTools: RoleTools;
  }): TurnBelt {
    const config = this.deps.getConfig();
    const light = config.light === true;
    const { context, search, planner, reviewer } = opts.roleTools;

    const toolConfig: ToolConfig = {
      workspaceRoot: config.workspaceRoot,
      approval: this.deps.approval,
      signal: opts.signal,
      commandPolicy: config.commandPolicy,
      limits: config.limits,
      // Every gated action names its author in the prompt. Only the coder has
      // write tools today, but "who is asking me to approve this" should be
      // answered on the panel rather than assumed.
      caller: { role: 'coder', model: `${opts.coderProfile.provider}/${resolveModel(opts.coderProfile)}` },
      // What the user actually asked for this turn — the only thing that lets
      // a reviewer (human or the safety agent) judge *scope*, not just the
      // action in isolation. Without it, "the user asked me to delete this
      // file" and "the agent decided to delete this file on its own" produce
      // an identical tool call.
      taskContext: opts.taskContext,
      // Session-scoped, so a file read in one turn is still editable in the
      // next — the belt around it is rebuilt every turn, this is not.
      readFiles: this.deps.readFiles,
      // Session-scoped for a second reason on top of that one: every belt that
      // can write has to queue on the *same* lock or it serialises only against
      // itself. Today that is one belt per turn; it stops being true the moment
      // a spawned agent gets write tools.
      fileLock: this.deps.fileLock,
      // Withholding the registry is what removes `background` from run_shell's
      // schema — the factory keys the option off its presence, so light mode
      // does not need the shell tool to know it exists.
      ...(light ? {} : { jobs: this.deps.jobs }),
    };

    const tools = [
      ...createFileTools(toolConfig, this.deps.dedupeCache),
      createShellTool(toolConfig),
      ...(light ? [] : createJobTools(toolConfig)),
      ...(light ? [] : createScratchTools(toolConfig)),
      ...(config.enableGitHub ? createGitHubTools(toolConfig) : []),
      ...(context ? [context] : []),
      ...(search ? [search] : []),
      ...(planner ? [planner] : []),
      ...(reviewer ? [reviewer] : []),
      // Only when the client can actually surface a question — without one the
      // model would be offered a tool with nowhere to ask.
      ...(this.deps.client.askUser
        ? [createAskTool((request) => this.deps.client.askUser!(request))]
        : []),
      // Rebuilt per turn: the wrapping binds this turn's approval fn, abort
      // signal and caller identity, none of which outlive the turn.
      ...this.deps.mcp.tools(toolConfig),
      this.deps.maskingPlugin.retrieveTool,
    ];

    const extraInstructions = [
      context ? CONTEXT_TOOL_GUIDANCE : '',
      planner ? PLANNER_TOOL_GUIDANCE : '',
      reviewer ? REVIEWER_TOOL_GUIDANCE : '',
      this.deps.client.askUser ? '\n\nUse ask_user for genuine ambiguity that blocks progress, not for confirmation.\n' : '',
    ].join('');

    return { tools, extraInstructions };
  }

  /**
   * Wraps `agentTool` with the engine's profile handling: the profile is
   * validated once up front, so an unusable one (missing key, unknown provider)
   * means the tool is absent rather than present and failing on every call.
   */
  private async buildAgentTool(opts: {
    name: string;
    description: string;
    /** Whose budget this tool's calls come out of, for the usage tally. */
    role: Role;
    profile: AgentProfile;
    systemPrompt: string;
    maxTokens?: number;
    /** Fresh tool belt per spawn — tools hold per-call state, so never shared. */
    makeTools?: () => Tool<unknown>[];
    builtInTools?: BuiltInTool[];
  }): Promise<Tool<string> | null> {
    const { client, log, events } = this.deps;

    const create = async (parent?: string) => {
      const tools = opts.makeTools?.() ?? [];
      const agent = await createAgent(opts.profile, tools, new History(), {
        maxTokens: opts.maxTokens ?? this.deps.getConfig().maxTokens,
        systemPrompt: opts.systemPrompt,
        name: opts.name,
        ...(opts.builtInTools ? { builtInTools: opts.builtInTools } : {}),
      });
      // Mirror the sub-agent's own reads to the transcript, tagged with the call
      // it belongs to. Otherwise a delegated survey is just a long pause. The
      // agent and its tools are discarded after the call, so these listeners go
      // with them — no detach needed.
      if (parent) events.attachSubAgentListeners(agent, tools, parent);
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
        log(`SUBAGENT ${opts.name}#${id} START ${label} ${JSON.stringify(instructions.slice(0, 200))}`),
      onEnd: ({ id, ms, error, result, usage }) => {
        // Keyed by a session-wide counter, not by the call id: `agentTool`
        // numbers its calls from zero and is rebuilt on every model switch, so
        // `context#0` recurs — and a tally keyed on it would have each turn's
        // first survey overwrite the last one's.
        if (usage) {
          this.deps.usage.record(`${opts.name}@${this.subagentSeq++}`, { role: opts.role, profile: opts.profile }, {
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
          });
        }
        log(
          `SUBAGENT ${opts.name}#${id} ${error ? 'ERROR' : 'DONE'} ${(ms / 1000).toFixed(1)}s ` +
          (usage ? `↑${usage.input_tokens} ↓${usage.output_tokens} ` : '') +
          (error ?? `${String(result ?? '').length} chars`),
        );
        client.onOutput({
          type: 'subagent-done',
          label: `${opts.name}#${id}`,
          durationMs: ms,
          chars: String(result ?? '').length,
          ...(error ? { error } : {}),
          ...(usage ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } : {}),
        });
      },
    });
  }

  /** Read-only file tools for a sub-agent, resolved against the current config. */
  private readOnlyFileTools(): Tool<unknown>[] {
    const config = this.deps.getConfig();
    return createReadOnlyFileTools(config.workspaceRoot, config.limits);
  }

  private buildContextTool(profile: AgentProfile): Promise<Tool<string> | null> {
    return this.buildAgentTool({
      name: 'context',
      role: 'context',
      description: 'Gather information from files and code in the workspace. Provide detailed instructions about what to look for. Safe to call several times in one turn — each call runs independently and in parallel.',
      profile,
      systemPrompt: CONTEXT_AGENT_PROMPT,
      makeTools: () => this.readOnlyFileTools(),
    });
  }

  /** Shared builder for the planner/reviewer sub-agents — both get read-only file
   *  access and their own isolated history, and differ only in prompt/tool name. */
  private buildReadOnlyAgentTool(
    profile: AgentProfile,
    opts: { name: string; role: Role; systemPrompt: string; description: string },
  ): Promise<Tool<string> | null> {
    return this.buildAgentTool({
      name: opts.name,
      role: opts.role,
      description: opts.description,
      profile,
      systemPrompt: opts.systemPrompt,
      makeTools: () => this.readOnlyFileTools(),
    });
  }

  /** Web search runs through its own sub-agent — search results are often large and
   *  noisy, so keeping them out of the main agent's context avoids burning its budget. */
  private buildSearchTool(profile: AgentProfile): Promise<Tool<string> | null> {
    return this.buildAgentTool({
      name: 'search',
      role: 'search',
      description: 'Search the web for current information. Provide a specific query and what you want to know.',
      profile,
      systemPrompt: SEARCH_AGENT_PROMPT,
      builtInTools: [webSearchTool({ maxUses: 5 })],
    });
  }
}
