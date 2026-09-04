// ── ranking system-prompt candidates with @agentionai/eval ──────────────────
//
// Manual A/B testing (bench/config.ts's ornith-*-prompt rows) found that
// swapping in `pi`'s wording cuts output tokens ~25% on the 28-file migration
// task, but that was pass/fail plus a token count — never a judgment of
// whether the code it produces is actually *good*. This is that judgment:
// `EvalRunner.rank()` runs every prompt candidate against the same short
// tasks, then asks an independent judge model to rank the outputs relative to
// each other. Relative ranking is used deliberately, not `Scorer.llm`'s
// absolute score — on an easy task every candidate scores 5/5 and the
// comparison saturates; ranking still discriminates.
//
// The candidates are the same four already benchmarked for tokens/duration —
// see docs/prompt-comparison notes — so a variant that wins here but wasn't
// also cheap gets weighed against that, not treated as a free win.

import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Session } from '@agentionai/marshall-engine';
import type { EngineConfig, ClientInterface, OutputEvent, AgentProfile } from '@agentionai/marshall-engine';
import { LlamaCppAgent } from '@agentionai/agents/llamacpp';
import { EvalDataset, EvalRunner, formatReport } from '@agentionai/eval';
import type { EvalTarget } from '@agentionai/eval';
import { BENCH_ENGINE_DEFAULTS, MODELS as BENCH_MODELS } from './config.js';
import { PROMPT_CANDIDATES } from './prompt-candidates.js';
import { TASKS } from './tasks.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, 'fixtures');
const HOST = process.env.MARSHALL_BENCH_HOST ?? 'http://127.0.0.1:8080';
// Which model the prompt candidates run on — swappable so the same ranking
// can be repeated against a different model to see whether a finding is
// about the prompt or an artefact of one model's behaviour, the way the
// long-task reasoning-burst finding was checked against Tiel-Coder.
const CANDIDATE_MODEL = process.env.PROMPT_EVAL_MODEL ?? BENCH_MODELS.ornith;
// Defaults to the local router; set to 'openrouter' to point the candidates
// at a hosted model (e.g. PROMPT_EVAL_MODEL=openai/gpt-5.6-luna) instead.
const CANDIDATE_PROVIDER = (process.env.PROMPT_EVAL_PROVIDER ?? 'llamacpp') as 'llamacpp' | 'openrouter';

// Short, deterministic tasks only — the 28-file migration is reserved as a
// confirmation run on whatever wins here, not part of the ranked sweep. Each
// one takes 10-30s against a local model; the full migration takes 5-10min,
// which would make a 4-candidate x N-case rank() sweep impractical to iterate.
const RANK_TASK_IDS = ['bug-fix', 'feature-add', 'refactor', 'iterate'];


function makeClient() {
  let response = '';
  const client: ClientInterface = {
    onOutput(event: OutputEvent) {
      if (event.type === 'response') response = event.text;
    },
    async requestApproval() { return 'approve'; },
  };
  return { client, response: () => response };
}

/**
 * One eval case's "input" is the task prompt itself, exactly as `rank()`
 * quotes it verbatim to the judge — so the judge sees the real instruction,
 * not a paraphrase. Which fixture to seed the workspace with travels in
 * `metadata`, since it isn't part of what a human (or judge) reading the case
 * needs to see.
 */
function buildDataset(): EvalDataset<string> {
  const cases = RANK_TASK_IDS.map(id => {
    const task = TASKS.find(t => t.id === id);
    if (!task) throw new Error(`bench task not found: ${id}`);
    return { name: task.id, input: task.prompt, metadata: { taskId: task.id, fixtureDir: task.fixtureDir } };
  });
  return new EvalDataset(cases);
}

/**
 * Runs one system-prompt candidate against our real engine and real tool
 * belt — the thing being ranked is the prompt actually shipping, not a
 * simplified stand-in for it.
 *
 * The judge sees three things, not just the model's closing remark: whether
 * the deterministic check passed (the judge cannot run `node --test` itself),
 * a summary of which files changed, and the model's own final response. A
 * prompt that produces a broken diff should rank last regardless of how it
 * describes its own work.
 */
/**
 * A process-wide lock, since `EvalRunner.rank()` runs every target's
 * `execute()` concurrently within one case regardless of the `concurrency`
 * option passed to `rank()` itself — that option only gates how many *cases*
 * run at once (confirmed by reading `runner.js`'s `rankCase`, then confirmed
 * the hard way: a run without this fix put four llama.cpp slots live at
 * once, `f_sim_best` dropping to 0.101, meaning candidates were evicting each
 * other's KV cache prefix mid-run). Every `execute()` that talks to the
 * model — every prompt candidate and the judge — queues on this one lock, so
 * only one request is ever in flight against the shared server.
 */
let modelLockTail: Promise<unknown> = Promise.resolve();
function withModelLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = modelLockTail.then(fn, fn);
  modelLockTail = result.catch(() => {});
  return result;
}

/** One candidate's run against one task — the completion-time/token data `rank()` itself never records (see `RankCaseResult` in @agentionai/eval's types.d.ts: no duration, no tokens). */
interface Execution {
  taskId: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  pass: boolean;
}

class MarshallPromptTarget implements EvalTarget<string> {
  /** Populated across the whole sweep, one entry per (task) this candidate ran — read after `EvalRunner.rank()` returns to build the timing/token table. */
  readonly executions: Execution[] = [];

  // withModelLock exists only to serialise access to one shared llama.cpp
  // GPU slot — irrelevant, and needlessly limiting, once the candidate is a
  // hosted model with no such contention.
  private readonly isLocal = CANDIDATE_PROVIDER === 'llamacpp';

  constructor(private readonly systemPromptOverride: string) {}

  async execute(taskPrompt: string): Promise<string> {
    return this.isLocal ? withModelLock(() => this.run(taskPrompt)) : this.run(taskPrompt);
  }

  private async run(taskPrompt: string): Promise<string> {
    const task = TASKS.find(t => t.prompt === taskPrompt);
    if (!task) throw new Error(`no bench task has prompt: ${taskPrompt.slice(0, 80)}`);

    const workspaceDir = await mkdtemp(join(tmpdir(), `marshall-promptval-${task.id}-`));
    await cp(join(FIXTURES_DIR, task.fixtureDir), workspaceDir, { recursive: true });

    const candidateAgent: AgentProfile = CANDIDATE_PROVIDER === 'openrouter'
      ? { provider: 'openrouter', model: CANDIDATE_MODEL }
      : { provider: 'llamacpp', model: CANDIDATE_MODEL, host: HOST };
    const engineConfig: EngineConfig = {
      ...BENCH_ENGINE_DEFAULTS,
      agent: candidateAgent,
      workspaceRoot: workspaceDir,
      systemPromptOverride: this.systemPromptOverride,
    };
    const { client, response } = makeClient();
    const session = new Session(engineConfig, client);

    const startMs = Date.now();
    try {
      await session.run(task.prompt);
    } catch (err) {
      this.executions.push({ taskId: task.id, durationMs: Date.now() - startMs, inputTokens: 0, outputTokens: 0, pass: false });
      await rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
      return `<<session error: ${(err as Error).message}>>`;
    }
    const durationMs = Date.now() - startMs;
    const usage = session.usageReport().session;

    const check = await task.check(workspaceDir, response());
    this.executions.push({ taskId: task.id, durationMs, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, pass: check.pass });
    await rm(workspaceDir, { recursive: true, force: true }).catch(() => {});

    return [
      `Check: ${check.pass ? 'PASS' : 'FAIL'} — ${check.summary.slice(0, 300)}`,
      `Final response: ${response() || '(none)'}`,
    ].join('\n\n');
  }
}

/**
 * A plain, tool-less judge — `rank()`'s `judge` type takes no input generic,
 * just `execute(prompt): Promise<string>`. Tiel-Coder rather than Ornith
 * deliberately: judging Ornith's own outputs with Ornith risks favouring
 * whichever candidate happens to sound most like its own house style.
 * Temperature 0, per the library's own guidance — a judge that varies between
 * runs makes the ranking incomparable across cases.
 */
class LocalJudge implements EvalTarget<string> {
  private readonly agent = new LlamaCppAgent({
    id: 'prompt-eval-judge',
    name: 'Judge',
    description: 'You are a precise evaluation judge. Return only JSON.',
    apiKey: 'local',
    model: BENCH_MODELS.tiel,
    baseURL: `${HOST}/v1`,
    temperature: 0,
  } as ConstructorParameters<typeof LlamaCppAgent>[0]);

  async execute(prompt: string): Promise<string> {
    return withModelLock(() => this.agent.execute(prompt));
  }
}

async function main() {
  const dataset = buildDataset();
  const judge = new LocalJudge();
  const targets: Record<string, EvalTarget<string>> = Object.fromEntries(
    Object.entries(PROMPT_CANDIDATES).map(([name, prompt]) => [name, new MarshallPromptTarget(prompt)]),
  );

  console.log(`Ranking ${Object.keys(targets).length} prompt candidates on ${CANDIDATE_MODEL} (${CANDIDATE_PROVIDER}) over ${dataset.size} tasks: ${RANK_TASK_IDS.join(', ')}`);
  console.log('Judge: Tiel-Coder (local, temperature 0) — independent of the candidate model, whichever it is.\n');

  const report = await EvalRunner.rank({
    dataset,
    targets,
    judge,
    criteria:
      'Which output correctly and cleanly completes the task? A FAIL check is disqualifying regardless ' +
      'of how the response describes itself. Among passing outputs, prefer the more direct, minimal diff.',
    // Gates cases, not the per-case exclusivity — rank()'s rankCase still
    // fires every target's execute() concurrently within one case regardless
    // of this value. withModelLock above is what actually serialises requests
    // to the shared llama.cpp slot; this just avoids piling up idle cases
    // behind the lock.
    concurrency: 1,
  });

  console.log('=== Leaderboard ===');
  report.leaderboard.forEach((t, i) =>
    console.log(`${i + 1}. ${t.name.padEnd(20)} wins: ${t.wins}  points: ${t.points}  avg rank: ${t.averageRank.toFixed(2)}`));

  console.log('\n=== Completion time & tokens (mean per task) ===');
  console.log(
    [`${'candidate'.padEnd(20)}`, 'pass', 'mean secs', 'mean in', 'mean out', 'total tok']
      .map((h, i) => i === 0 ? h : h.padStart(10)).join(''),
  );
  for (const name of report.leaderboard.map(t => t.name)) {
    const target = targets[name] as MarshallPromptTarget;
    const runs = target.executions;
    const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    const passed = runs.filter(r => r.pass).length;
    const totalTok = runs.reduce((a, r) => a + r.inputTokens + r.outputTokens, 0);
    console.log(
      name.padEnd(20)
      + `${passed}/${runs.length}`.padStart(10)
      + (mean(runs.map(r => r.durationMs)) / 1000).toFixed(1).padStart(10)
      + Math.round(mean(runs.map(r => r.inputTokens))).toString().padStart(10)
      + Math.round(mean(runs.map(r => r.outputTokens))).toString().padStart(10)
      + totalTok.toLocaleString().padStart(10),
    );
  }
  console.log('\n=== Per-task detail ===');
  for (const name of report.leaderboard.map(t => t.name)) {
    const target = targets[name] as MarshallPromptTarget;
    for (const r of target.executions) {
      console.log(`  ${name.padEnd(20)} ${r.taskId.padEnd(16)} ${r.pass ? 'PASS' : 'FAIL'}  ${(r.durationMs / 1000).toFixed(1).padStart(6)}s  in=${r.inputTokens}  out=${r.outputTokens}`);
    }
  }

  console.log('\n=== Per-case reasoning ===');
  for (const c of report.cases) {
    console.log(`\n[${c.case.name}] ranking: ${c.ranking.join(' > ') || '(unparseable)'}`);
    if (c.reason) console.log(`  ${c.reason}`);
  }

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
