import { parseArgs } from 'node:util';
import { mkdtemp, cp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Session } from '@agentionai/marshall-engine';
import type { EngineConfig, ClientInterface, OutputEvent } from '@agentionai/marshall-engine';
import { CONFIGURATIONS, EXTERNAL_HARNESSES, BENCH_ENGINE_DEFAULTS, TASK_TIMEOUT_MS, INSTRUMENTED_MODEL } from './config.js';
import { installFetchProbe } from './instrument.js';
import { fetchJournal, parseJournal, findPortForModel } from './llama-journal.js';
import type { LlamaRequest } from './llama-journal.js';
import { summarize, toCsv, tgSamples, median, REQUEST_COLUMNS } from './metrics.js';
import type { RunMetrics } from './metrics.js';
import type { BenchConfiguration } from './config.js';
import { TASKS } from './tasks.js';
import type { BenchTask } from './tasks.js';
import { runExternal } from './external-harness.js';
import type { ExternalHarnessConfig } from './external-harness.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, 'fixtures');

interface RunResult {
  config: string;
  task: string;
  trial: number;
  pass: boolean;
  timedOut: boolean;
  error?: string;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  /** USD, when the provider has a known price — absent for local models
   *  (llamacpp/ollama) and for any harness that doesn't report cost. */
  costUsd?: number;
  /** `null` for a harness with no tool-calling concept — see ExternalRunOutcome. */
  toolCalls: number | null;
  checkSummary: string;

  /**
   * Per-request measurements from llama-server's own slot logs. Absent for any
   * config not running against the local router — the journal is the only
   * source for these, and no remote provider reports them.
   */
  metrics?: RunMetrics;
  /** History compressions the engine performed, from its own session log. */
  compactions?: number;
  /**
   * Cross-check: the engine's own token tally against what the server recorded.
   * A mismatch means the journal window caught requests that weren't ours (or
   * missed some that were), so every metric above is suspect for that run.
   */
  tallyMatchesJournal?: boolean;
}

const execFileAsync = promisify(execFile);

/**
 * Requests the journal attributes to this run.
 *
 * Filtered three ways: to the child port serving this model, to the run's own
 * wall-clock window, and — because journalctl's window has one-second
 * granularity and is queried with a second of slack — to requests that started
 * no earlier than the run did. Without the last filter a request still in
 * flight when the run began is picked up as if it were ours.
 */
async function collectRunJournal(
  model: string, since: Date, until: Date,
): Promise<{ requests: LlamaRequest[]; raw: string; port?: number }> {
  const port = await findPortForModel(model, since);
  const raw = await fetchJournal(since, until);
  if (port === undefined) return { requests: [], raw };
  const startMs = since.getTime();
  const requests = parseJournal(raw, port)
    .filter(r => new Date(r.startedAt).getTime() >= startMs - 1000);
  return { requests, raw, port };
}

/** `REDUCE_STEP`/`COMPRESSED` lines the engine writes when it shrinks history. */
async function readCompactions(workspaceDir: string): Promise<{ count: number; log: string; historyLog: string; reasoningLog: string }> {
  const read = async (name: string) => {
    try { return await readFile(join(workspaceDir, '.marshall', 'logs', name), 'utf8'); }
    catch { return ''; }
  };
  // history.log carries the engine's own per-turn estimate of how big the
  // history is — the number compression decides against. Archived alongside
  // the journal because the two disagreeing is itself a finding: a first run
  // reached 80k tokens of real context against a stated 40k threshold without
  // ever compressing, which only makes sense if the estimate is well under the
  // truth. Without this file that cannot be checked after the fact.
  const [log, historyLog, reasoningLog] = await Promise.all([
    read('session.log'), read('history.log'), read('reasoning.log'),
  ]);
  return { count: (log.match(/^\[[^\]]+\] COMPRESSED /gm) ?? []).length, log, historyLog, reasoningLog };
}

function makeClient() {
  let toolCallCount = 0;
  let usage: { input: number; output: number; costUsd?: number } | null = null;
  const errors: string[] = [];
  // A code-editing task never reads this; a Q&A task's check is entirely this
  // string. Kept as the *last* response seen rather than concatenating every
  // one, matching what a user of the CLI would actually be shown as "the
  // answer" for the turn.
  let response = '';

  const client: ClientInterface = {
    onOutput(event: OutputEvent) {
      if (event.type === 'tool-call') toolCallCount++;
      // `session`, not `turn`: a bench task is one `session.run()` call, so
      // they're numerically the same here, but `session` is the total the
      // field is actually named for. Only `event.final` carries the settled
      // number — earlier `usage` events in the same turn are progress
      // snapshots taken mid-stream and can under-report by a lot.
      else if (event.type === 'usage' && event.final) {
        usage = { input: event.session.inputTokens, output: event.session.outputTokens, costUsd: event.session.costUsd };
      }
      else if (event.type === 'error') errors.push(event.message);
      else if (event.type === 'response') response = event.text;
    },
    async requestApproval() {
      return 'approve'; // unattended benchmark run — no human in the loop
    },
  };

  return {
    client,
    toolCalls: () => toolCallCount,
    usage: () => usage,
    errors: () => errors,
    response: () => response,
  };
}

interface RunContext {
  /** Directory this run's artifacts are written to, or undefined to skip them. */
  runDir?: string;
  timeoutMs: number;
}

async function runOne(config: BenchConfiguration, task: BenchTask, trial: number, ctx: RunContext): Promise<RunResult> {
  const workspaceDir = await mkdtemp(join(tmpdir(), `marshall-bench-${task.id}-`));
  const source = isAbsolute(task.fixtureDir) ? task.fixtureDir : join(FIXTURES_DIR, task.fixtureDir);
  await cp(source, workspaceDir, { recursive: true });

  const engineConfig: EngineConfig = {
    ...BENCH_ENGINE_DEFAULTS,
    agent: config.agent,
    contextAgent: config.contextAgent,
    plannerAgent: config.plannerAgent,
    reviewerAgent: config.reviewerAgent,
    workspaceRoot: workspaceDir,
    ...(config.light ? { light: true } : {}),
    ...(config.noMasking ? { maskToolResults: false } : {}),
    ...(config.toolAllowlist ? { toolAllowlist: config.toolAllowlist } : {}),
    ...(config.readLineNumbers ? { limits: { ...BENCH_ENGINE_DEFAULTS.limits, readLineNumbers: true } } : {}),
    ...(config.systemPromptOverride ? { systemPromptOverride: config.systemPromptOverride } : {}),
  };

  const { client, toolCalls, usage, errors, response } = makeClient();
  const session = new Session(engineConfig, client);

  const probe = installFetchProbe();
  const startedAt = new Date();
  const startMs = Date.now();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    session.interrupt();
  }, ctx.timeoutMs);

  try {
    await session.run(task.prompt);
  } finally {
    clearTimeout(timer);
    probe.restore();
  }

  const durationMs = Date.now() - startMs;
  const endedAt = new Date();

  // Before the workspace is removed: the engine's own log lives inside it.
  const { count: compactions, log: sessionLog, historyLog, reasoningLog } = await readCompactions(workspaceDir);
  const check = await task.check(workspaceDir, response());

  // The journal is only a source for configs running against the local router.
  // Anything else (openrouter, a remote host) has no slot logs to read.
  const journalModel = config.agent.provider === 'llamacpp' ? config.agent.model : undefined;
  let requests: LlamaRequest[] = [];
  let rawJournal = '';
  let port: number | undefined;
  if (journalModel) {
    try {
      ({ requests, raw: rawJournal, port } = await collectRunJournal(journalModel, startedAt, endedAt));
    } catch (err) {
      process.stderr.write(`[warn] journal unavailable: ${(err as Error).message}\n`);
    }
  }

  const calls = probe.calls();
  const metrics = requests.length ? summarize(requests, calls, durationMs) : undefined;
  const u = usage();

  // The engine counts output tokens from the provider's usage blocks; the
  // server counts them as it generates them. They describe the same tokens by
  // two independent routes, so agreement is real evidence the journal window
  // caught this run and only this run.
  const tallyMatchesJournal = metrics?.tokensReceived !== undefined && u
    ? Math.abs(metrics.tokensReceived - u.output) <= Math.max(2, u.output * 0.02)
    : undefined;

  if (ctx.runDir) {
    await writeRunArtifacts(ctx.runDir, config.name, task.id, trial, {
      requests, rawJournal, calls, sessionLog, historyLog, reasoningLog, port,
    });
  }

  if (process.env.MARSHALL_BENCH_KEEP_ALL) {
    process.stderr.write(`[debug] kept workspace: ${workspaceDir}\n`);
  } else if (check.pass || !process.env.MARSHALL_BENCH_KEEP_FAILED) {
    await rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
  } else {
    process.stderr.write(`[debug] kept failing workspace: ${workspaceDir}\n`);
  }

  return {
    config: config.name,
    task: task.id,
    trial,
    pass: check.pass && !timedOut,
    timedOut,
    error: errors()[0],
    durationMs,
    inputTokens: u?.input,
    outputTokens: u?.output,
    costUsd: u?.costUsd,
    toolCalls: toolCalls(),
    checkSummary: check.summary,
    metrics,
    compactions,
    tallyMatchesJournal,
  };
}

/**
 * Writes one run's raw evidence next to its numbers.
 *
 * The journal slice is archived verbatim rather than only in parsed form:
 * `SystemMaxUse=100M` means journald rotates, so by the time anyone questions a
 * figure the lines behind it may be gone. Everything here is reconstructable
 * from `journal.log` alone if the parser later turns out to be wrong.
 */
async function writeRunArtifacts(
  runDir: string, configName: string, taskId: string, trial: number,
  data: { requests: LlamaRequest[]; rawJournal: string; calls: unknown[]; sessionLog: string; historyLog?: string; reasoningLog?: string; port?: number },
): Promise<void> {
  const dir = join(runDir, `${configName}__${taskId}__trial${trial}`);
  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeFile(join(dir, 'requests.csv'), toCsv(data.requests as unknown as Record<string, unknown>[], REQUEST_COLUMNS)),
    writeFile(join(dir, 'tg-samples.csv'), toCsv(
      tgSamples(data.requests.filter(r => r.complete)).map((s, i) => ({ index: i, tps: s.value, sampled: s.sampled })),
      ['index', 'tps', 'sampled'],
    )),
    writeFile(join(dir, 'api-calls.json'), JSON.stringify(data.calls, null, 2)),
    data.rawJournal ? writeFile(join(dir, 'journal.log'), data.rawJournal) : Promise.resolve(),
    data.sessionLog ? writeFile(join(dir, 'session.log'), data.sessionLog) : Promise.resolve(),
    data.historyLog ? writeFile(join(dir, 'history.log'), data.historyLog) : Promise.resolve(),
    data.reasoningLog ? writeFile(join(dir, 'reasoning.log'), data.reasoningLog) : Promise.resolve(),
  ]);
}

/** Same shape as `runOne`, driving `pi`/`opencode` instead of `Session`. */
async function runOneExternal(config: ExternalHarnessConfig, task: BenchTask, trial: number, apiKey: string, ctx: RunContext): Promise<RunResult> {
  const workspaceDir = await mkdtemp(join(tmpdir(), `marshall-bench-${task.id}-`));
  const source = isAbsolute(task.fixtureDir) ? task.fixtureDir : join(FIXTURES_DIR, task.fixtureDir);
  await cp(source, workspaceDir, { recursive: true });

  const startedAt = new Date();
  const startMs = Date.now();
  const artifactDir = ctx.runDir ? join(ctx.runDir, `${config.name}__${task.id}__trial${trial}`) : undefined;
  if (artifactDir) await mkdir(artifactDir, { recursive: true });
  let timedOut = false;
  let outcome: Awaited<ReturnType<typeof runExternal>>;
  try {
    outcome = await Promise.race([
      runExternal(config, task, workspaceDir, apiKey, ctx.timeoutMs,
        artifactDir ? { transcriptPath: join(artifactDir, 'transcript.ndjson') } : {}),
      new Promise<never>((_, reject) => setTimeout(() => { timedOut = true; reject(new Error('timeout')); }, ctx.timeoutMs)),
    ]);
  } catch (err) {
    outcome = { response: '', toolCalls: 0, error: timedOut ? 'timeout' : (err as Error).message };
  }
  const durationMs = Date.now() - startMs;
  const endedAt = new Date();

  // A harness-level error (crash, rate limit, timeout) never reaches
  // check() — there is nothing to verify an empty, error'd run against, and
  // running the check anyway would report "missing required facts" for a
  // reason that has nothing to do with the model's answer.
  const check = outcome.error
    ? { pass: false, summary: `harness error: ${outcome.error}` }
    : await task.check(workspaceDir, outcome.response);

  // The whole point of running an external harness against the local router:
  // llama-server logs every request it serves regardless of which client sent
  // it, so a pi row gets exactly the same per-request measurements as a
  // marshall row, from the same source, rather than from each CLI's own
  // self-reporting. Nothing here is harness-specific.
  let requests: LlamaRequest[] = [];
  let rawJournal = '';
  if (config.provider === 'llama-cpp') {
    try {
      ({ requests, raw: rawJournal } = await collectRunJournal(config.model, startedAt, endedAt));
    } catch (err) {
      process.stderr.write(`[warn] journal unavailable: ${(err as Error).message}\n`);
    }
  }
  const metrics = requests.length ? summarize(requests, [], durationMs) : undefined;
  const tallyMatchesJournal = metrics?.tokensReceived !== undefined && outcome.outputTokens
    ? Math.abs(metrics.tokensReceived - outcome.outputTokens) <= Math.max(2, outcome.outputTokens * 0.02)
    : undefined;

  if (ctx.runDir) {
    await writeRunArtifacts(ctx.runDir, config.name, task.id, trial, {
      requests, rawJournal, calls: [], sessionLog: '',
    });
  }

  if (process.env.MARSHALL_BENCH_KEEP_ALL) {
    process.stderr.write(`[debug] kept workspace: ${workspaceDir}\n`);
  } else if (check.pass || !process.env.MARSHALL_BENCH_KEEP_FAILED) {
    await rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
  } else {
    process.stderr.write(`[debug] kept failing workspace: ${workspaceDir}\n`);
  }

  return {
    config: config.name,
    task: task.id,
    trial,
    pass: check.pass && !timedOut,
    timedOut,
    error: outcome.error,
    durationMs,
    inputTokens: outcome.inputTokens,
    outputTokens: outcome.outputTokens,
    costUsd: outcome.costUsd,
    toolCalls: outcome.toolCalls,
    checkSummary: check.summary,
    metrics,
    tallyMatchesJournal,
  };
}

async function gitSha(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: __dirname });
    return stdout.trim();
  } catch { return undefined; }
}

function printTable(results: RunResult[]) {
  console.table(results.map(r => ({
    config: r.config,
    task: r.task,
    trial: r.trial,
    result: r.timedOut ? 'TIMEOUT' : r.pass ? 'PASS' : 'FAIL',
    seconds: (r.durationMs / 1000).toFixed(1),
    inTok: r.inputTokens ?? '-',
    outTok: r.outputTokens ?? '-',
    costUsd: r.costUsd !== undefined ? `$${r.costUsd.toFixed(4)}` : '-',
    toolCalls: r.toolCalls ?? 'n/a',
  })));
}

/**
 * The instrumented columns, kept in their own table.
 *
 * Deliberately not merged into the main results table: these come from a
 * different source (llama-server's slot logs, not the API) and are only
 * available for local-router runs, so a merged table would be half empty and
 * would invite reading a journal figure and an API figure as one row.
 */
function printMetricsTable(results: RunResult[]) {
  const rows = results.filter(r => r.metrics).map(r => {
    const m = r.metrics!;
    return {
      config: r.config,
      task: r.task,
      trial: r.trial,
      reqs: m.apiCalls,
      sent: m.tokensSent ?? '-',
      peakCtx: m.peakContextTokens ?? '-',
      recomputed: m.tokensRecomputed ?? '-',
      'recomp%': m.recomputedShare !== undefined ? `${(m.recomputedShare * 100).toFixed(1)}%` : '-',
      recv: m.tokensReceived ?? '-',
      'tg med': m.tgMedian?.toFixed(1) ?? '-',
      'tg p10': m.tgP10?.toFixed(1) ?? '-',
      'eff t/s': m.effectiveTps?.toFixed(1) ?? '-',
      rewrites: m.historyRewrites ?? '-',
      compact: r.compactions ?? '-',
      trunc: m.anyTruncated ? 'YES' : 'no',
      tally: r.tallyMatchesJournal === undefined ? '-' : r.tallyMatchesJournal ? 'ok' : 'MISMATCH',
    };
  });
  if (rows.length) {
    console.log('\n=== Per-request measurements (from llama-server slot logs) ===');
    console.table(rows);
  }
}

function avg(nums: number[]): number | undefined {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : undefined;
}

/** Aggregates repeated trials of the same (config, task) into a pass rate + averages. */
function printSummary(results: RunResult[]) {
  const groups = new Map<string, RunResult[]>();
  for (const r of results) {
    const key = `${r.config} ${r.task}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }

  const rows = [...groups.values()].map(group => {
    const passes = group.filter(r => r.pass).length;
    return {
      config: group[0].config,
      task: group[0].task,
      passRate: `${passes}/${group.length}`,
      // Median, not mean: three trials is few enough that one timeout or one
      // unlucky slot eviction drags a mean somewhere no individual run went.
      medSeconds: (median(group.map(r => r.durationMs)) ?? 0) / 1000,
      medPeakCtx: median(group.map(r => r.metrics?.peakContextTokens ?? NaN).filter(n => !Number.isNaN(n))),
      medTg: median(group.map(r => r.metrics?.tgMedian ?? NaN).filter(n => !Number.isNaN(n))),
      avgInTok: avg(group.map(r => r.inputTokens ?? NaN).filter(n => !Number.isNaN(n))),
      avgOutTok: avg(group.map(r => r.outputTokens ?? NaN).filter(n => !Number.isNaN(n))),
      avgCostUsd: avg(group.map(r => r.costUsd ?? NaN).filter(n => !Number.isNaN(n))),
      // Averaged over the rows that have the concept, so a harness without
      // it reports n/a rather than dragging a real mean toward zero.
      avgToolCalls: avg(group.map(r => r.toolCalls ?? NaN).filter(n => !Number.isNaN(n))),
    };
  });

  console.table(rows.map(r => ({
    config: r.config,
    task: r.task,
    passRate: r.passRate,
    medSeconds: r.medSeconds.toFixed(1),
    medPeakCtx: r.medPeakCtx?.toFixed(0) ?? '-',
    medTg: r.medTg?.toFixed(1) ?? '-',
    avgInTok: r.avgInTok?.toFixed(0) ?? '-',
    avgOutTok: r.avgOutTok?.toFixed(0) ?? '-',
    avgCostUsd: r.avgCostUsd !== undefined ? `$${r.avgCostUsd.toFixed(4)}` : '-',
    avgToolCalls: r.avgToolCalls?.toFixed(1) ?? '-',
  })));
}

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', multiple: true },
      task: { type: 'string', multiple: true },
      trials: { type: 'string' },
      list: { type: 'boolean' },
      timeout: { type: 'string' },
      'no-artifacts': { type: 'boolean' },
    },
  });

  if (values.list) {
    console.log('Configurations:', CONFIGURATIONS.map(c => c.name).join(', '));
    console.log('External harnesses (opt-in, name explicitly with --config):', EXTERNAL_HARNESSES.map(c => c.name).join(', '));
    console.log('Tasks:', TASKS.map(t => t.id).join(', '));
    return;
  }

  // External harnesses only run when named explicitly — see EXTERNAL_HARNESSES's
  // doc comment for why they're not in the default sweep.
  const configs = values.config?.length
    ? CONFIGURATIONS.filter(c => values.config!.includes(c.name))
    : CONFIGURATIONS;
  const externalConfigs = values.config?.length
    ? EXTERNAL_HARNESSES.filter(c => values.config!.includes(c.name))
    : [];
  const tasks = values.task?.length
    ? TASKS.filter(t => values.task!.includes(t.id))
    : TASKS;
  const trials = values.trials ? Number.parseInt(values.trials, 10) : 1;
  const timeoutMs = values.timeout ? Number.parseInt(values.timeout, 10) * 1000 : TASK_TIMEOUT_MS;

  // The engine's character-based history estimate, written per turn, is a third
  // independent reading of context size alongside the journal and the API's
  // usage block. It costs one append per turn and it is the only one of the
  // three that shows what compression was *aiming* at.
  process.env.MARSHALL_TRACE_HISTORY ??= '1';
  // Reasoning is the remaining unmeasured component of a run's output tokens.
  // `ASSISTANT_TEXT ... 0 chars` on every turn ruled out narration between
  // tool calls, which leaves thinking and tool arguments — and only one of
  // those is already visible.
  process.env.MARSHALL_TRACE_REASONING ??= '1';

  const startedAt = new Date();
  const runDir = values['no-artifacts']
    ? undefined
    : join(__dirname, 'runs', startedAt.toISOString().replace(/[:.]/g, '-'));
  if (runDir) {
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'header.json'), JSON.stringify({
      startedAt: startedAt.toISOString(),
      host: process.env.MARSHALL_BENCH_HOST ?? 'http://127.0.0.1:8080',
      instrumentedModel: INSTRUMENTED_MODEL,
      // The models actually exercised, not just the instrumented default — a
      // header that names one model while the run used another is worse than
      // no header at all.
      configs: [
        ...configs.map(c => ({ name: c.name, provider: c.agent.provider, model: c.agent.model })),
        ...externalConfigs.map(c => ({ name: c.name, provider: 'external', model: c.model })),
      ],
      tasks: tasks.map(t => t.id),
      trials,
      timeoutMs,
      gitSha: await gitSha(),
    }, null, 2));
  }
  const ctx: RunContext = { runDir, timeoutMs };

  const apiKey = process.env.OPENROUTER_API_KEY ?? '';
  // Only the rows that actually reach OpenRouter need the key — a local-router
  // row (see EXTERNAL_HARNESSES's `pi-ornith`) authenticates nothing, and
  // demanding a key for it would block the one comparison that costs nothing.
  const needsKey = externalConfigs.some(c => (c.provider ?? 'openrouter') === 'openrouter');
  if (needsKey && !apiKey) {
    console.error('OPENROUTER_API_KEY is required to run an OpenRouter-backed external harness.');
    process.exit(1);
  }

  const results: RunResult[] = [];
  for (const config of configs) {
    for (const task of tasks) {
      for (let trial = 1; trial <= trials; trial++) {
        const label = trials > 1 ? `${config.name} / ${task.id} / trial ${trial}` : `${config.name} / ${task.id}`;
        process.stdout.write(`\n[${label}] running...\n`);
        const result = await runOne(config, task, trial, ctx);
        results.push(result);
        process.stdout.write(
          `[${label}] ${result.timedOut ? 'TIMEOUT' : result.pass ? 'PASS' : 'FAIL'} ` +
          `in ${(result.durationMs / 1000).toFixed(1)}s, ${result.toolCalls ?? 'n/a'} tool calls, ` +
          `tokens ${result.inputTokens ?? '?'}/${result.outputTokens ?? '?'}\n`,
        );
      }
    }
  }
  for (const config of externalConfigs) {
    for (const task of tasks) {
      for (let trial = 1; trial <= trials; trial++) {
        const label = trials > 1 ? `${config.name} / ${task.id} / trial ${trial}` : `${config.name} / ${task.id}`;
        process.stdout.write(`\n[${label}] running...\n`);
        const result = await runOneExternal(config, task, trial, apiKey, ctx);
        results.push(result);
        process.stdout.write(
          `[${label}] ${result.timedOut ? 'TIMEOUT' : result.pass ? 'PASS' : 'FAIL'} ` +
          `in ${(result.durationMs / 1000).toFixed(1)}s, ${result.toolCalls ?? 'n/a'} tool calls, ` +
          `tokens ${result.inputTokens ?? '?'}/${result.outputTokens ?? '?'}` +
          `${result.error ? ` (error: ${result.error})` : ''}\n`,
        );
      }
    }
  }

  console.log('\n=== Results ===');
  printTable(results);
  printMetricsTable(results);
  if (trials > 1) {
    console.log('\n=== Summary (aggregated across trials) ===');
    printSummary(results);
  }

  // results.json used to be a single file at the bench root, overwritten by
  // every run. It is written per-run now, alongside that run's raw evidence,
  // so an old number can still be traced back to the journal lines behind it.
  const outPath = join(runDir ?? __dirname, 'results.json');
  await writeFile(outPath, JSON.stringify(results, null, 2));
  console.log(`\nSaved to ${outPath}`);

  // `script` (see external-harness.ts's execViaPty) leaves something in the
  // event loop even after its own promise resolves — every external-harness
  // run finishes and prints correctly, but the process otherwise hangs
  // rather than exiting. Explicit rather than investigated further: results
  // are on disk by this point, so there is nothing left an exit could lose.
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
