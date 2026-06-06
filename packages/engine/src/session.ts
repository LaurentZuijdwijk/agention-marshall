import { join } from 'node:path';
import { readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { History, AgentEvent } from '@agentionai/agents/core';
import { toolResultMaskingPlugin, compressionPlugin } from '@agentionai/agents/history/plugins';
import type { ToolResultMaskingPlugin } from '@agentionai/agents/history/plugins';
import {
  createFileTools,
  createShellTool,
  createScratchTools,
  createGitHubTools,
  createDedupeCache,
} from '@marshall/tools';
import type { ToolConfig, DedupeCache } from '@marshall/tools';
import { createAgent } from './agent-factory.js';
import { cheapModelFor } from './config.js';
import type { EngineConfig, AgentProfile } from './config.js';
import type { ClientInterface } from './types.js';

// Tool results from these tools are always kept verbatim — they're small,
// structural, or represent the agent's own working memory.
const NEVER_MASK_TOOLS = [
  'list_dir', 'note_write', 'note_read', 'note_list', 'log_append', 'log_read',
];

export class Session {
  private readonly history: History;
  private readonly maskingPlugin: ToolResultMaskingPlugin;
  private readonly dedupeCache: DedupeCache;
  private compressionReady = false;
  private controller: AbortController | null = null;
  private currentTask: string | null = null;
  private steeringContext: string | null = null;

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
  }

  get hasSteering(): boolean {
    return this.steeringContext !== null;
  }

  /** Set up compression on first run (requires async agent creation). */
  private async ensureCompression(): Promise<void> {
    if (this.compressionReady) return;
    this.compressionReady = true; // set early so concurrent calls don't double-init

    const threshold = this.config.compressionThreshold ?? 40_000;
    if (threshold === 0) return;

    const summaryProfile: AgentProfile = {
      ...this.config.agent,
      model: this.config.compressionModel ?? cheapModelFor(this.config.agent.provider),
    };

    try {
      const summaryAgent = await createAgent(summaryProfile, [], new History(), 1024);
      this.history.use(compressionPlugin(summaryAgent, {
        autoReduceWhen: { maxTokens: threshold },
      }));
    } catch {
      // If the summariser can't be created (e.g. bad model name), skip
      // compression rather than crashing the whole session.
    }
  }

  async run(task: string): Promise<void> {
    if (this.controller) {
      this.client.onOutput({ type: 'error', message: 'A task is already running.' });
      return;
    }

    // Claim the slot synchronously before any awaits so concurrent calls
    // are rejected even if ensureCompression() hasn't returned yet.
    this.controller = new AbortController();

    await this.ensureCompression();

    // Load project memory from AGENTS.md at workspace root (re-read each run
    // so edits take effect without restarting).
    const memoryPath = join(this.config.workspaceRoot, 'AGENTS.md');
    const projectMemory = existsSync(memoryPath)
      ? await readFile(memoryPath, 'utf8').catch(() => '')
      : '';

    const steering = this.steeringContext;
    this.steeringContext = null;

    const effectiveTask = steering
      ? `[Previous task was interrupted: "${steering}"]\n\nNew direction: ${task}`
      : task;

    this.currentTask = task;
    let errorReported = false;

    try {
      const toolConfig: ToolConfig = {
        workspaceRoot: this.config.workspaceRoot,
        approval: (req) => this.client.requestApproval(req),
        signal: this.controller.signal,
        commandPolicy: this.config.commandPolicy,
        limits: this.config.limits,
      };

      const tools = [
        ...createFileTools(toolConfig, this.dedupeCache),
        createShellTool(toolConfig),
        ...createScratchTools(toolConfig),
        ...(this.config.enableGitHub ? createGitHubTools(toolConfig) : []),
        this.maskingPlugin.retrieveTool,
      ];

      const agent = await createAgent(
        this.config.agent,
        tools,
        this.history,
        this.config.maxTokens,
        projectMemory || undefined,
      );

      agent.on(AgentEvent.TOOL_USE, (content: unknown) => {
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (block && typeof block === 'object' && 'type' in block && block.type === 'tool_use') {
            const b = block as { name: string; input: unknown };
            this.client.onOutput({ type: 'tool-call', toolName: b.name, input: b.input });
          }
        }
      });

      agent.on(AgentEvent.ERROR, (err: unknown) => {
        errorReported = true;
        const message = err instanceof Error ? err.message : String(err);
        this.client.onOutput({ type: 'error', message });
      });

      this.client.onOutput({ type: 'thinking' });
      const response = await (agent as { execute(input: string): Promise<string> }).execute(effectiveTask);

      const usage = (agent as { lastTokenUsage?: { input_tokens: number; output_tokens: number } }).lastTokenUsage;
      if (usage) {
        this.client.onOutput({ type: 'usage', inputTokens: usage.input_tokens, outputTokens: usage.output_tokens });
      }

      this.client.onOutput({ type: 'response', text: response });
    } catch (err) {
      if (this.controller?.signal.aborted) {
        try {
          this.history.addText('user', `[Task was interrupted by the user: "${task}"]`);
        } catch { /* history might be mid-flight */ }
        this.client.onOutput({ type: 'interrupted' });
      } else if (!errorReported) {
        this.client.onOutput({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      this.currentTask = null;
      this.controller = null;
    }
  }

  interrupt(): void {
    if (this.currentTask) {
      this.steeringContext = this.currentTask;
    }
    this.controller?.abort();
  }

  /**
   * Clear all in-session memory:
   *   - conversation history + masking state
   *   - steering context
   *   - read-dedupe cache
   *   - scratch notes (.marshall/notes/)
   *
   * The session log (.marshall/session.log) is kept — it is a historical
   * record, not working memory.
   */
  async clear(): Promise<string> {
    this.history.clear();
    this.steeringContext = null;
    this.dedupeCache.clear();

    const notesDir = join(this.config.workspaceRoot, '.marshall', 'notes');
    let notesCleared = 0;

    if (existsSync(notesDir)) {
      const files = await readdir(notesDir);
      const notes = files.filter(f => f.endsWith('.md'));
      await Promise.all(notes.map(f => rm(join(notesDir, f), { force: true })));
      notesCleared = notes.length;
    }

    return notesCleared > 0
      ? `history, dedupe cache, and ${notesCleared} scratch note${notesCleared === 1 ? '' : 's'} cleared`
      : 'history and dedupe cache cleared';
  }
}
