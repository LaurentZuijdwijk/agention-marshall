import { join, dirname } from 'node:path';
import { readFile, readdir, rm, appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { History, AgentEvent, BaseAgent, Tool, ToolResultEvent, webSearchTool } from '@agentionai/agents/core';
import { toolResultMaskingPlugin, compressionPlugin } from '@agentionai/agents/history/plugins';
import type { ToolResultMaskingPlugin } from '@agentionai/agents/history/plugins';
import {
  createFileTools,
  createReadOnlyFileTools,
  createShellTool,
  createScratchTools,
  createGitHubTools,
  createDedupeCache,
} from '@marshall/tools';
import type { ToolConfig, DedupeCache } from '@marshall/tools';
import type { ApprovalDecision, ApprovalRequest } from '@marshall/tools';
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
import { cheapModelFor } from './config.js';
import type { EngineConfig, AgentProfile } from './config.js';
import type { ClientInterface } from './types.js';

interface AgentWithUsage extends BaseAgent<string, string> {
  lastTokenUsage?: { input_tokens: number; output_tokens: number };
}

const NEVER_MASK_TOOLS = [
  'list_dir', 'note_write', 'note_read', 'note_list', 'log_append', 'log_read', 'context', 'search',
];

export class Session {
  private readonly history: History;
  private readonly maskingPlugin: ToolResultMaskingPlugin;
  private readonly dedupeCache: DedupeCache;
  private readonly alwaysApproved = new Set<string>();
  private readonly logPath: string;
  private readonly logDirReady: Promise<void>;
  private compressionReady = false;
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

    this.contextToolReady = config.contextAgent
      ? this.buildContextTool(config.contextAgent)
      : Promise.resolve(null);

    this.searchToolReady = config.enableWebSearch !== false && config.agent.provider === 'claude'
      ? this.buildSearchTool()
      : Promise.resolve(null);

    this.plannerToolReady = config.plannerAgent
      ? this.buildReadOnlyAgentTool(config.plannerAgent, {
          name: 'planner',
          systemPrompt: PLANNER_AGENT_PROMPT,
          description: 'Get a step-by-step plan for a coding task before starting. Provide the task description; returns an ordered list of concrete steps and files to touch.',
        })
      : Promise.resolve(null);

    this.reviewerToolReady = config.reviewerAgent
      ? this.buildReadOnlyAgentTool(config.reviewerAgent, {
          name: 'reviewer',
          systemPrompt: REVIEWER_AGENT_PROMPT,
          description: 'Get a second opinion on changes before finishing. Describe the task and what you changed; the reviewer reads the actual files and flags bugs or missed requirements.',
        })
      : Promise.resolve(null);
  }

  private async buildContextTool(profile: AgentProfile): Promise<Tool<string> | null> {
    try {
      const tools = createReadOnlyFileTools(this.config.workspaceRoot, this.config.limits);
      const agent = await createAgent(profile, tools, new History(), {
        maxTokens: 4096,
        systemPrompt: CONTEXT_AGENT_PROMPT,
        name: 'context',
      });
      return Tool.fromAgent(agent, 'Gather information from files and code in the workspace. Provide detailed instructions about what to look for.');
    } catch {
      return null;
    }
  }

  /** Shared builder for the planner/reviewer sub-agents — both get read-only file
   *  access and their own isolated history, and differ only in prompt/tool name. */
  private async buildReadOnlyAgentTool(
    profile: AgentProfile,
    opts: { name: string; systemPrompt: string; description: string },
  ): Promise<Tool<string> | null> {
    try {
      const tools = createReadOnlyFileTools(this.config.workspaceRoot, this.config.limits);
      const agent = await createAgent(profile, tools, new History(), {
        maxTokens: 4096,
        systemPrompt: opts.systemPrompt,
        name: opts.name,
      });
      return Tool.fromAgent(agent, opts.description);
    } catch {
      return null;
    }
  }

  /** Web search runs through its own sub-agent — search results are often large and
   *  noisy, so keeping them out of the main agent's context avoids burning its budget. */
  private async buildSearchTool(): Promise<Tool<string> | null> {
    try {
      const profile: AgentProfile = { ...this.config.agent, model: cheapModelFor(this.config.agent.provider) ?? this.config.agent.model };
      const agent = await createAgent(profile, [], new History(), {
        maxTokens: 2048,
        systemPrompt: SEARCH_AGENT_PROMPT,
        builtInTools: [webSearchTool({ maxUses: 5 })],
        name: 'search',
      });
      return Tool.fromAgent(agent, 'Search the web for current information. Provide a specific query and what you want to know.');
    } catch {
      return null;
    }
  }

  get hasSteering(): boolean {
    return this.steeringContext !== null;
  }

  get hasPendingPlan(): boolean {
    return this.pendingPlan !== null;
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

    const summaryProfile: AgentProfile = {
      ...this.config.agent,
      model: this.config.compressionModel ?? cheapModelFor(this.config.agent.provider) ?? this.config.agent.model,
    };
    try {
      const summaryAgent = await createAgent(summaryProfile, [], new History(), { maxTokens: 1024 });
      this.history.use(compressionPlugin(summaryAgent, {
        autoReduceWhen: { maxTokens: threshold },
      }));
    } catch { /* skip compression if summariser can't be created */ }
  }

  /** Approval function that honours the per-session always-approve list. */
  private makeApproval(): (req: ApprovalRequest) => Promise<ApprovalDecision> {
    return async (req) => {
      if (this.alwaysApproved.has(req.toolName)) {
        this.log(`TOOL ${req.toolName} auto-approved (always)`);
        return 'approve';
      }
      const decision = await this.client.requestApproval(req);
      if (decision === 'always') {
        this.alwaysApproved.add(req.toolName);
        this.log(`TOOL ${req.toolName} approved (always — added to session list)`);
      } else {
        this.log(`TOOL ${req.toolName} ${decision === 'approve' ? 'approved' : 'denied'}`);
      }
      return decision;
    };
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

    try {
      const toolConfig: ToolConfig = {
        workspaceRoot: this.config.workspaceRoot,
        approval: this.makeApproval(),
        signal,
        commandPolicy: this.config.commandPolicy,
        limits: this.config.limits,
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

      for (const tool of tools) {
        tool.on(ToolResultEvent.RESULT, (event: InstanceType<typeof ToolResultEvent>) => {
          if (signal.aborted) return;
          const preview = String(event.result).slice(0, 500);
          this.client.onOutput({ type: 'tool-result', toolName: event.target.name, result: preview });
        });
      }

      const extraInstructions = [
        contextTool ? CONTEXT_TOOL_GUIDANCE : '',
        plannerTool ? PLANNER_TOOL_GUIDANCE : '',
        reviewerTool ? REVIEWER_TOOL_GUIDANCE : '',
      ].join('');

      const agent = await createAgent(this.config.agent, tools, this.history, {
        maxTokens: this.config.maxTokens,
        projectMemory: projectMemory || undefined,
        extraInstructions: extraInstructions || undefined,
      }) as AgentWithUsage;

      agent.on(AgentEvent.TOOL_USE, (content: unknown) => {
        if (signal.aborted) return;
        this.log(`TOOL_USE_RAW ${JSON.stringify(content).slice(0, 300)}`);
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          // Anthropic format: { type: 'tool_use', name, input }
          if ('type' in block && block.type === 'tool_use') {
            const b = block as { name: string; input: unknown };
            this.client.onOutput({ type: 'tool-call', toolName: b.name, input: b.input });
            this.log(`TOOL_CALL ${b.name} ${JSON.stringify(b.input ?? {}).slice(0, 200)}`);
          // OpenAI/llamacpp format: { type: 'function', function: { name, arguments } }
          } else if ('type' in block && block.type === 'function' && 'function' in block) {
            const b = block as { function: { name: string; arguments: string } };
            let input: unknown;
            try { input = JSON.parse(b.function.arguments); } catch { input = b.function.arguments; }
            this.client.onOutput({ type: 'tool-call', toolName: b.function.name, input });
            this.log(`TOOL_CALL ${b.function.name} ${b.function.arguments.slice(0, 200)}`);
          }
        }
      });

      agent.on('token', (text: unknown) => {
        if (signal.aborted) return;
        if (typeof text === 'string') this.client.onOutput({ type: 'token', text });
      });

      agent.on('reasoning', (text: unknown) => {
        if (signal.aborted) return;
        if (typeof text === 'string') this.client.onOutput({ type: 'reasoning', text });
      });

      agent.on(AgentEvent.ERROR, (err: unknown) => {
        if (signal.aborted) return;
        errorReported = true;
        const message = err instanceof Error ? err.message : String(err);
        this.client.onOutput({ type: 'error', message });
        this.log(`ERROR ${message}`);
      });

      this.client.onOutput({ type: 'thinking' });
      // Race instead of a plain await: the agent SDK has no cancellation hook, so
      // agent.execute() itself won't reject on abort — without this race, Esc would
      // do nothing until the model's current turn (and any tool-blocked retries it
      // attempts afterward) finished on its own, which can take minutes on local models.
      const response = await new Promise<string>((resolve, reject) => {
        agent.execute(effectiveTask).then(resolve, reject);
        signal.addEventListener('abort', () => {
          reject(new DOMException('Task interrupted by user', 'AbortError'));
        }, { once: true });
      });

      const durationMs = Date.now() - startMs;
      const usage = agent.lastTokenUsage;
      if (usage) {
        this.client.onOutput({
          type: 'usage',
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          durationMs,
        });
        this.log(`DONE ↑${usage.input_tokens} ↓${usage.output_tokens} tokens ${(durationMs / 1000).toFixed(1)}s`);
      }

      this.client.onOutput({ type: 'response', text: response });
    } catch (err) {
      if (this.controller?.signal.aborted) {
        try { this.history.addText('user', `[Task was interrupted by the user: "${task}"]`); } catch {}
        this.log(`INTERRUPTED after ${((Date.now() - startMs) / 1000).toFixed(1)}s`);
        this.client.onOutput({ type: 'interrupted' });
      } else if (!errorReported) {
        const message = err instanceof Error ? err.message : String(err);
        this.log(`ERROR ${message}`);
        this.client.onOutput({ type: 'error', message });
      }
    } finally {
      this.currentTask = null;
      this.controller = null;
    }
  }

  /** Shared runner for /plan and /review — a one-shot, read-only sub-agent call
   *  that doesn't touch the main coder's history or tools. */
  private async runSideAgent(
    profile: AgentProfile | undefined,
    systemPrompt: string,
    prompt: string,
    eventType: 'plan' | 'review',
  ): Promise<void> {
    if (this.controller) {
      this.client.onOutput({ type: 'error', message: 'A task is already running.' });
      return;
    }

    this.controller = new AbortController();
    const startMs = Date.now();
    this.log(`${eventType.toUpperCase()} ${JSON.stringify(prompt)}`);

    try {
      const tools = createReadOnlyFileTools(this.config.workspaceRoot, this.config.limits);
      const agent = await createAgent(profile ?? this.config.agent, tools, new History(), {
        maxTokens: 4096,
        systemPrompt,
        name: eventType,
      }) as AgentWithUsage;

      this.client.onOutput({ type: 'thinking' });
      const text = await agent.execute(prompt);

      const durationMs = Date.now() - startMs;
      const usage = agent.lastTokenUsage;
      if (usage) {
        this.client.onOutput({
          type: 'usage',
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          durationMs,
        });
      }

      if (eventType === 'plan') this.pendingPlan = text;
      this.client.onOutput({ type: eventType, text });
      this.log(`${eventType.toUpperCase()}_DONE ${(durationMs / 1000).toFixed(1)}s`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`ERROR ${message}`);
      this.client.onOutput({ type: 'error', message });
    } finally {
      this.controller = null;
    }
  }

  /** Runs the planner alone (no edits) and holds the result to prepend as
   *  context onto the next run() call — lets the user see/approve the plan
   *  before any code changes happen. */
  async plan(task: string): Promise<void> {
    await this.runSideAgent(this.config.plannerAgent, PLANNER_AGENT_PROMPT, task, 'plan');
  }

  /** Runs the reviewer alone against the current workspace state — usable any
   *  time, independent of whether a task is mid-flight. */
  async review(instructions?: string): Promise<void> {
    const prompt = instructions
      ? `Review the current state of the workspace. ${instructions}`
      : 'Review the current state of the workspace for correctness, obvious bugs, or incomplete work.';
    await this.runSideAgent(this.config.reviewerAgent, REVIEWER_AGENT_PROMPT, prompt, 'review');
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
