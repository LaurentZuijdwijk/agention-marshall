import { History } from '@agentionai/agents/core';
import type { BaseAgent } from '@agentionai/agents/core';
import { isTextContent, isToolResultContent, isToolUseContent } from '@agentionai/agents/core';
import type { HistoryPlugin, ReducibleEntry } from '@agentionai/agents/core';
import { createAgent } from './agent-factory.js';
import { resolveRoleProfile, resolveModel } from './config.js';
import type { EngineConfig } from './config.js';
import { describeAgentError, providerErrorDiagnostics } from './errors.js';

/**
 * Keeping a session's history inside the model's context window.
 *
 * Owns the summariser agent and the one compression plugin registered on the
 * session's History. That ownership is the reason this is a class held for the
 * session's lifetime rather than something rebuilt per turn: `History.use` has
 * no counterpart, so a second manager over the same History would stack a
 * second plugin and compound summarisation on every reduce. Construct one per
 * Session and call `invalidateModel()` on a model switch.
 *
 * Everything here is best-effort. A summariser that cannot be reached costs
 * the session compression, never the turn.
 */

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
const COMPRESSION_STEP_TOKENS = 3_000;

/**
 * Extra room to cut beyond the measured overage — the retry adds a fresh
 * copy of the current turn on top of whatever's left, so trimming to an
 * exact fit just fails again.
 */
const CONTEXT_ERROR_MARGIN = 1_024;

/**
 * Compression is already a lossy operation. Do not send raw tool transcripts
 * back through the model: a single file/search result can be larger than the
 * local model's entire context window and makes every bounded reduce step
 * expensive. Keep the shape of each tool result — the full details are dropped
 * along with the source entries once reduce() replaces them with the summary.
 */
const TOOL_PROMPT_LIMIT = 1_200;
/**
 * A backstop, not the working limit. `reduceToTarget` steps by
 * `COMPRESSION_STEP_TOKENS`, so a single reduce folds ~3k tokens (~12k chars)
 * of middle window into the prompt and never comes near this. Set low enough to
 * bind on a normal step and it would quietly drop content the summariser was
 * asked to preserve, which is worse than a large prompt: the step bound is what
 * keeps the request small, and this only catches the pathological case.
 */
const SUMMARY_PROMPT_LIMIT = 24_000;

export function compactSummaryPrompt(prompt: string): string {
  const compacted = prompt.split('\n').map((line) => {
    if (!/^\[tool\]:/i.test(line) || line.length <= TOOL_PROMPT_LIMIT) return line;
    return `${line.slice(0, TOOL_PROMPT_LIMIT)} …[tool output omitted during compression]`;
  }).join('\n');

  if (compacted.length <= SUMMARY_PROMPT_LIMIT) return compacted;
  return `${compacted.slice(0, SUMMARY_PROMPT_LIMIT)}\n[older compression input omitted]`;
}

function entryText(entry: ReducibleEntry): string {
  return entry.content.map((block) => {
    if (isTextContent(block)) return block.text;
    if (isToolUseContent(block)) return `[tool call: ${block.name}]`;
    if (isToolResultContent(block)) return `[tool]: ${block.content}`;
    return '';
  }).filter(Boolean).join(' ');
}

export function middleCompressionPlugin(execute: (prompt: string) => Promise<string>): HistoryPlugin {
  return {
    async reduce(entries, options) {
      const { maxTokens } = options;
      if (maxTokens === undefined) return entries;
      const system = entries.filter((entry) => entry.role === 'system');
      const nonSystem = entries.filter((entry) => entry.role !== 'system');
      const total = entries.reduce((sum, entry) => sum + entry.__metadata.estimatedTokens, 0);
      if (total <= maxTokens || nonSystem.length < 3) return entries;

      // Preserve the first conversational entry and the newest entries. Compress
      // only a contiguous middle window, ending before the recent tail.
      const first = nonSystem[0];
      const tail: ReducibleEntry[] = [];
      let retained = system.reduce((sum, entry) => sum + entry.__metadata.estimatedTokens, 0)
        + first.__metadata.estimatedTokens;
      for (let i = nonSystem.length - 1; i > 0; i--) {
        const entry = nonSystem[i];
        if (retained + entry.__metadata.estimatedTokens > maxTokens && tail.length > 0) break;
        tail.unshift(entry);
        retained += entry.__metadata.estimatedTokens;
      }
      const middle = nonSystem.slice(1, nonSystem.length - tail.length);
      if (middle.length === 0) return entries;

      const priorSummary = middle.find((entry) => entry.__metadata.isSummary);
      const prompt = [
        'Produce a concise summary of this middle section of a conversation. Preserve key facts, decisions, and outcomes. Omit filler.',
        priorSummary ? `Prior summary:\n${entryText(priorSummary)}` : '',
        ...middle.filter((entry) => entry !== priorSummary).map((entry) => `[${entry.role}]: ${entryText(entry)}`),
      ].filter(Boolean).join('\n\n');
      const summaryText = await execute(compactSummaryPrompt(prompt));
      const covered = middle.filter((entry) => entry !== priorSummary);
      const firstCovered = priorSummary ?? covered[0];
      const lastCovered = covered[covered.length - 1] ?? priorSummary;
      const summary: ReducibleEntry = {
        role: 'user',
        content: [{ type: 'text', text: `[Earlier conversation summary: ${summaryText}]` }],
        __metadata: {
          date: new Date().toISOString(),
          contentLength: summaryText.length,
          estimatedTokens: Math.ceil(summaryText.length / 4),
          isSummary: true,
          coversRange: { from: firstCovered.__metadata.coversRange?.from ?? firstCovered.__metadata.date, to: lastCovered.__metadata.coversRange?.to ?? lastCovered.__metadata.date },
        },
      };
      return [...system, first, summary, ...tail];
    },
  };
}

export class CompressionManager {
  private ready = false;
  /** The plugin can only be added once — History has no removal. */
  private registered = false;
  /** Token threshold once the summariser is live; null while compression is off. */
  private threshold: number | null = null;
  /**
   * The agent the compression plugin summarises with.
   *
   * Held in a field rather than captured by the plugin because `History.use`
   * has no counterpart — a plugin can be registered but never removed. So the
   * plugin is registered once with a stable delegate (see `ensure`) and a model
   * switch swaps what sits behind it. Registering a second plugin per switch
   * would compound summarisation on every reduce.
   */
  private summaryAgent: BaseAgent<string, string> | null = null;

  /**
   * `getConfig` is a getter, not a value: the session replaces its config
   * wholesale on every `/model`, `/runtime` and `/safety` change, so a snapshot
   * taken here would go stale the first time the user switches models.
   */
  constructor(
    private readonly history: History,
    private readonly getConfig: () => EngineConfig,
    private readonly log: (line: string) => void,
  ) {}

  /**
   * Drop the summariser after a model switch, keeping the plugin registered.
   * Rebuilt lazily by the next `ensure`, so a switch costs nothing until
   * history is big enough to compress.
   */
  invalidateModel(): void {
    this.summaryAgent = null;
    this.ready = false;
  }

  async ensure(): Promise<void> {
    if (this.ready) return;
    this.ready = true;

    const config = this.getConfig();
    const threshold = config.compressionThreshold ?? 40_000;
    if (threshold === 0) return;

    const summaryProfile = resolveRoleProfile(config, 'summarizer');
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
      this.threshold = threshold;
      this.log(`COMPRESSION_READY summariser=${summaryProfile.provider}/${resolveModel(summaryProfile)} threshold=${threshold}`);
    } catch (err) {
      // Skip compression if the summariser can't be created. Reset `ready` so a
      // later attempt (the next ensure, or a switch to a reachable model via
      // invalidateModel) retries instead of short-circuiting on the stale flag.
      // Without this, `ready` stays true while `threshold` stays null, so the
      // failure disables compression for the rest of the session silently.
      this.ready = false;
      this.log(`COMPRESSION_UNAVAILABLE summariser=${summaryProfile.provider}/${resolveModel(summaryProfile)} ${describeAgentError('summarizer', summaryProfile, err)} details=${providerErrorDiagnostics(err)}`);
      return;
    }

    if (this.registered) return;
    this.registered = true;

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
    this.history.use(middleCompressionPlugin(async (prompt: string) => {
      const agent = this.summaryAgent;
      if (!agent) throw new Error('no summariser is configured');
      return agent.execute(prompt);
    }));
  }

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
      const stepTarget = Math.max(target, before - COMPRESSION_STEP_TOKENS);
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
  async compressIfNeeded(): Promise<void> {
    const threshold = this.threshold;
    if (threshold === null) return;
    if (this.history.totalEstimatedTokens < threshold) return;

    try {
      await this.reduceToTarget(threshold);
      this.log(`COMPRESSED to ~${this.history.totalEstimatedTokens} tokens`);
    } catch (err) {
      const profile = resolveRoleProfile(this.getConfig(), 'summarizer');
      this.log(`COMPRESSION_FAILED ${describeAgentError('summarizer', profile, err)} details=${providerErrorDiagnostics(err)}`);
    }
  }

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
      const target = Math.max(0, current - overage - CONTEXT_ERROR_MARGIN);
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

  async compressForContextError(message: string): Promise<boolean> {
    this.log(`CONTEXT_ERROR_COMPRESS_START ${JSON.stringify(message)}`);

    if (!this.summaryAgent) await this.ensure();
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
      const profile = resolveRoleProfile(this.getConfig(), 'summarizer');
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
}
