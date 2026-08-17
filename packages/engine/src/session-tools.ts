import { History, webSearchTool, Tool, ToolResultEvent } from '@agentionai/agents/core';
import type { BuiltInTool, ToolInputSchema } from '@agentionai/agents/core';
import type { ToolResultMaskingPlugin } from '@agentionai/agents/history/plugins';
import {
  createFileTools,
  createReadOnlyFileTools,
  createShellTool,
  createScratchTools,
  createGitHubTools,
  createJobTools,
  createAskTool,
  createDedupeCache,
  withApproval,
} from '@agentionai/marshall-tools';
import type {
  ToolConfig, ToolSpec, DedupeCache, BackgroundJobs, ApprovalFn, KeyedLock,
} from '@agentionai/marshall-tools';
import {
  createAgent,
  CONTEXT_AGENT_PROMPT,
  SEARCH_AGENT_PROMPT,
  PLANNER_AGENT_PROMPT,
  REVIEWER_AGENT_PROMPT,
  CONTEXT_TOOL_GUIDANCE,
  PLANNER_TOOL_GUIDANCE,
  REVIEWER_TOOL_GUIDANCE,
  SWARM_TOOL_GUIDANCE,
  SPAWN_TOOL_DESCRIPTION,
  buildSwarmPrompt,
} from './agent-factory.js';
import { agentTool } from './agent-tool.js';
import { summariseAgentJob } from './agent-jobs.js';
import type { AgentJobs, AgentToolset } from './agent-jobs.js';
import { McpRegistry } from './mcp.js';
import {
  resolveRoleProfile, resolveModel, contextToolEnabled, resolveSearchProfile, resolveTierProfile,
  resolveNamedAgent,
} from './config.js';
import type { EngineConfig, AgentProfile, Role, SwarmRole, Tier, NamedAgent } from './config.js';
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

/** Same shape as the one in `job-tools.ts`, for the same reason: the ungated
 *  read/stop tools are all schema and no ceremony. */
function tool(spec: {
  name: string;
  description: string;
  properties: Record<string, unknown>;
  required: string[];
  execute: (input: Record<string, unknown>) => Promise<string>;
}): Tool<string> {
  return new Tool<string>({
    name: spec.name,
    description: spec.description,
    inputSchema: {
      type: 'object',
      properties: spec.properties,
      required: spec.required,
    } as unknown as ToolInputSchema,
    execute: spec.execute,
  });
}

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
  /** Session-scoped registry of spawned agents — see agent-jobs.ts. */
  agentJobs: AgentJobs;
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
      // Light mode is single-agent by definition, so spawning is out there for
      // the same reason the sub-agent tools are.
      ...(config.swarm && !light ? this.swarmTools(toolConfig) : []),
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
      config.swarm && !light ? SWARM_TOOL_GUIDANCE : '',
      planner ? PLANNER_TOOL_GUIDANCE : '',
      reviewer ? REVIEWER_TOOL_GUIDANCE : '',
      this.deps.client.askUser ? '\n\nUse ask_user for genuine ambiguity that blocks progress, not for confirmation.\n' : '',
    ].join('');

    return { tools, extraInstructions };
  }

  // ── swarm ───────────────────────────────────────────────────────────────────

  /**
   * `spawn_agent` and the three tools for living with what it started.
   *
   * Only `spawn_agent` is gated, and that is the whole design: consent is given
   * once, to a brief, and every action the agent then takes is judged against
   * that brief rather than against the user's turn instruction. Which makes the
   * gate load-bearing in a way the others are not — an ungated spawn would let
   * an agent write its own scope and then be judged against it.
   *
   * The other three follow `createJobTools`' reasoning exactly: reading is
   * inert, and stopping something is inside the blast radius the user accepted
   * when they let it start. Making an agent ask permission to clean up after
   * itself mostly teaches it not to bother.
   */
  private swarmTools(parent: ToolConfig): Tool<unknown>[] {
    const jobs = this.deps.agentJobs;
    const namedAgents = this.deps.getConfig().namedAgents ?? [];

    const properties: NonNullable<ToolInputSchema['properties']> = {
      brief: {
        type: 'string',
        description:
          'Self-contained reasonably detailed instructions: what to change, where, what "done" looks like, and ' +
          'anything it must not touch. The agent sees nothing else — not this conversation, ' +
          'not your plan, not the other agents.',
      },
      agent_name: {
        type: 'string',
        enum: ['fast', ...namedAgents.map(a => a.name)],
        description:
          'The agent persona to delegate to. Use "fast" for mechanical or fully specified work; ' +
          (namedAgents.length > 0
            ? `or use one of the configured profiles for specific work: ${namedAgents.map(a => this.describeNamedAgentOption(a)).join(', ')}.`
            : ''),
      },
      toolset: {
        type: 'string',
        enum: ['readonly', 'edit', 'full'],
        description:
          'readonly to investigate, edit to change files, full to also run commands. Ask for ' +
          'the least the brief needs: the user approves this, and a smaller ask is approved faster.' +
          (namedAgents.some(a => a.toolset)
            ? ' Not needed for a named agent whose own toolset is already fixed — see agent_name.'
            : ''),
      },
    };
    const spawn: ToolSpec = {
      name: 'spawn_agent',
      description: SPAWN_TOOL_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties,
        required: ['brief', 'agent_name', 'toolset'],
      },
      execute: async ({ brief, agent_name, toolset }) => {
        const target = this.resolveSpawnTarget(
          agent_name as string | undefined, toolset as AgentToolset | undefined,
        );
        if (typeof target === 'string') return target;

        const job = jobs.start({
          brief: String(brief),
          agentName: agent_name as string,
          toolset: target.toolset,
          timeoutMs: this.deps.getConfig().agentTimeoutMs,
          label: target.label,
          run: ({ id, signal }) => this.runSpawnedAgent({
            id, signal, brief: String(brief),
            agentName: agent_name as string, profile: target.profile, toolset: target.toolset,
          }),
        });
        this.deps.log(`SWARM ${job.id} START ${job.agentName ?? job.tier} ${job.toolset} ${job.label} ${JSON.stringify(job.brief.slice(0, 200))}`);
        const who = job.agentName ? `"${job.agentName}"` : `the ${job.tier} tier`;
        return (
          `Started ${job.id} on ${who} (${job.label}), toolset "${job.toolset}". ` +
          `It is running now — carry on, and you will be told when it finishes.`
        );
      },
    };

    return [
      withApproval(
        spawn,
        parent.approval,
        (input) => {
          const target = this.resolveSpawnTarget(
            input.agent_name as string | undefined, input.toolset as AgentToolset | undefined,
          );
          // An unknown name still has to show something at the gate; the raw
          // model input is the best available answer.
          const label = typeof target === 'string' ? target : target.label;
          const toolsetLabel = typeof target === 'string' ? String(input.toolset) : target.toolset;
          const who = `"${String(input.agent_name)}" agent`;
          return {
            toolName: 'spawn_agent',
            description: `Start a ${who} (${toolsetLabel}) — ${label}`,
            // The brief *is* the consent question. Shown whole and unabridged:
            // this is the one prompt where truncating the detail would hide the
            // very thing being agreed to, since everything the agent later does
            // is measured against these words.
            detail: String(input.brief),
          };
        },
        parent.signal,
        parent.caller,
        parent.taskContext,
      ),

      tool({
        name: 'agent_list',
        description: 'List the agents spawned this session, with their status and how long they have run.',
        properties: {},
        required: [],
        execute: async () => {
          const all = jobs.list();
          if (all.length === 0) return 'No agents have been spawned in this session.';
          return all.map(summariseAgentJob).join('\n');
        },
      }),

      tool({
        name: 'agent_output',
        description:
          'Read an agent\'s report. Returns its status, and its final report once it has finished — ' +
          'each report only once, since you are also told it directly. Use this to check on an agent ' +
          'mid-run; you do not need it to learn that one finished.',
        properties: {
          agent_id: { type: 'string', description: 'The id returned by spawn_agent, e.g. "agent1"' },
        },
        required: ['agent_id'],
        execute: async ({ agent_id }) => this.describeAgent(String(agent_id)),
      }),

      tool({
        name: 'agent_kill',
        description:
          'Stop a running agent. Use it when its work has been made obsolete by a later change, or ' +
          'when it is doing something the brief did not ask for.',
        properties: {
          agent_id: { type: 'string', description: 'The id returned by spawn_agent, e.g. "agent1"' },
        },
        required: ['agent_id'],
        execute: async ({ agent_id }) => {
          const id = String(agent_id);
          const job = jobs.get(id);
          if (!job) return this.unknownAgent(id);
          if (!jobs.kill(id)) return `${id} had already ${job.status === 'done' ? 'finished' : job.status}.`;
          this.deps.log(`SWARM ${id} KILLED by parent`);
          return `Stopped ${id}.`;
        },
      }),
    ];
  }

  /** `provider/model` for a tier, as the approval panel and the log name it. */
  private swarmLabel(tier: Tier): string {
    const profile = resolveTierProfile(this.deps.getConfig(), tier);
    return `${profile.provider}/${resolveModel(profile)}`;
  }

  /**
   * What `spawn_agent`'s `tier`/`agent_name` resolve to — the profile and
   * toolset to run with, and the label to show at the approval gate and in
   * the job list. Returns a plain-text error, not a throw, for the same
   * reason `unknownAgent`/`unknownNamedAgent` do: a model that got the call
   * wrong should be told so in its tool result, not crash the turn.
   *
   * A named agent's own `toolset`, when it has one, wins over whatever the
   * caller passed — that is the whole point of pinning it: a "tester" fixed
   * to `edit` should not be trusted to ask for `full` instead, so its own
   * setting is authoritative rather than a default the caller can override.
   *
   * A named agent is looked up before falling back to the built-in `fast`
   * sentinel: nothing stops `/team add` from naming a custom agent "fast",
   * and a user's own configured agent must not be shadowed by the tier of
   * the same name.
   */
  private resolveSpawnTarget(
    agentName: string | undefined,
    toolset: AgentToolset | undefined,
  ): { profile: AgentProfile; label: string; toolset: AgentToolset } | string {
    if (!agentName) return 'Give an agent_name.';
    const named = resolveNamedAgent(this.deps.getConfig(), agentName);
    if (named) {
      const resolvedToolset = named.toolset ?? toolset;
      if (!resolvedToolset) return `"${agentName}" has no fixed toolset — give one: readonly, edit or full.`;
      return {
        profile: named.profile,
        label: `${named.profile.provider}/${resolveModel(named.profile)}`,
        toolset: resolvedToolset,
      };
    }
    if (agentName === 'fast') {
      if (!toolset) return 'Give a toolset: readonly, edit or full.';
      return {
        profile: resolveTierProfile(this.deps.getConfig(), 'fast'),
        label: this.swarmLabel('fast'),
        toolset,
      };
    }
    return this.unknownNamedAgent(agentName);
  }

  private unknownNamedAgent(name: string): string {
    const known = (this.deps.getConfig().namedAgents ?? []).map(a => a.name);
    return known.length
      ? `No agent named "${name}". Configured: ${known.join(', ')}.`
      : `No agent named "${name}" — none are configured. Use /team add to define one.`;
  }

  /** One `agent_name` enum entry's description: what it's for, and whether
   *  its toolset is fixed (so the model knows whether it still needs to pass
   *  one). */
  private describeNamedAgentOption(agent: NamedAgent): string {
    const purpose = agent.description ?? `${agent.profile.provider}/${agent.profile.model ?? 'default'}`;
    return agent.toolset ? `"${agent.name}" (${purpose}, toolset fixed to ${agent.toolset})` : `"${agent.name}" (${purpose})`;
  }

  private unknownAgent(id: string): string {
    const known = this.deps.agentJobs.list().map(j => j.id);
    return known.length
      ? `No agent "${id}". Known agents: ${known.join(', ')}.`
      : `No agent "${id}" — nothing has been spawned in this session.`;
  }

  private describeAgent(id: string): string {
    const jobs = this.deps.agentJobs;
    const job = jobs.get(id);
    if (!job) return this.unknownAgent(id);

    const parts = [summariseAgentJob(job)];
    const report = jobs.read(id);
    if (report) {
      parts.push(report);
    } else if (job.status === 'running') {
      const activity = jobs.activity(id);
      parts.push(activity.length
        ? `Working. Recently:\n${activity.map(line => `  ${line}`).join('\n')}`
        : 'Working. Nothing to report yet.');
    } else if (job.error) {
      parts.push(`Failed: ${job.error}`);
    } else {
      parts.push('Its report has already been delivered to you.');
    }
    return parts.join('\n\n');
  }

  /**
   * One spawned agent, from construction to final report.
   *
   * The belt it gets is deliberately not `forTurn`'s. Three things differ, and
   * each is a correctness point rather than a preference:
   *
   * - **Its own `readFiles`.** Shared, agent B could overwrite a file only agent
   *   A had read, and "read it first" would stop meaning anything per agent.
   *   Nothing is lost by separating them, because the staleness check compares
   *   against *disk*: B's write is still refused if A got there in between.
   * - **Its own dedupe cache.** Shared, `read_file` would answer "unchanged
   *   since last read" to an agent that has never read the file, and hand it a
   *   line count instead of the contents.
   * - **The session `fileLock`.** The one thing that must be shared, or two
   *   agents editing one file serialise against nothing.
   *
   * It also gets no `jobs` (a background command outliving the agent that
   * started it has no owner) and no `ask_user` (there may be nobody watching,
   * and the conversation belongs to the parent). `spawn_agent` is absent too,
   * which is what bounds depth — structurally, with nothing to police.
   */
  private async runSpawnedAgent(opts: {
    id: string;
    signal: AbortSignal;
    brief: string;
    agentName: string;
    profile: AgentProfile;
    toolset: AgentToolset;
  }): Promise<string> {
    const config = this.deps.getConfig();
    const named = resolveNamedAgent(config, opts.agentName);
    const profile = opts.profile;
    const role: SwarmRole = opts.agentName === 'fast' ? 'swarm:fast' : `swarm:agent:${opts.agentName}`;
    const label = `${profile.provider}/${resolveModel(profile)}`;

    const toolConfig: ToolConfig = {
      workspaceRoot: config.workspaceRoot,
      approval: this.deps.approval,
      signal: opts.signal,
      commandPolicy: config.commandPolicy,
      limits: config.limits,
      // `id` is what separates two live agents at the gate — without it they are
      // one actor, and approving one agent's write approves the other's.
      caller: { role, model: label, id: `${role}#${opts.id}` },
      // The brief, not the user's turn instruction. A delegated action is in
      // scope if it serves the brief it was given, and the brief is what the
      // user approved at the spawn gate.
      taskContext: opts.brief,
      readFiles: new Map(),
      fileLock: this.deps.fileLock,
    };

    const tools = this.spawnedTools(toolConfig, opts.toolset);
    const agent = await createAgent(profile, tools, new History(), {
      maxTokens: config.maxTokens,
      systemPrompt: buildSwarmPrompt(opts.toolset, named?.description),
      name: opts.id,
    });
    this.deps.events.attachSubAgentListeners(agent, tools, opts.id);
    for (const t of tools) {
      t.on(ToolResultEvent.RESULT, (event: InstanceType<typeof ToolResultEvent>) => {
        this.deps.agentJobs.note(opts.id, event.target.name);
      });
    }

    try {
      return await agent.execute(opts.brief, { signal: opts.signal });
    } finally {
      // In `finally` so a cancelled or failed agent is still billed. One that
      // burned its context and died is exactly the one worth seeing on the bill.
      const usage = agent.lastTokenUsage;
      if (usage) {
        this.deps.usage.record(`${opts.id}@${this.subagentSeq++}`, { role, profile }, {
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
        });
      }
    }
  }

  /** The belt a spawned agent gets, by the toolset its parent asked for. */
  private spawnedTools(config: ToolConfig, toolset: AgentToolset): Tool<unknown>[] {
    if (toolset === 'readonly') {
      return createReadOnlyFileTools(config.workspaceRoot, config.limits);
    }
    return [
      ...createFileTools(config, createDedupeCache()),
      ...(toolset === 'full' ? [createShellTool(config)] : []),
    ];
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
