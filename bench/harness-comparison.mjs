// ── harness comparison: marshall vs pi vs opencode ──────────────────────────
//
// Reads every results.json under bench/runs/ and renders one self-contained
// HTML page comparing the three harnesses on the same task, model and
// check() verifier.
//
// Two things this deliberately does not do.
//
// It does not pool trials across code states. marshall's numbers moved several
// times in one day (the read gate came out, the shell guidance went in), so a
// mean over every marshall trial ever recorded would describe no version of the
// software. Each marshall config is therefore read from its LATEST run
// directory only, and the run id is printed beside it. `pi` and `opencode` are
// external CLIs that marshall's changes cannot affect, so their trials pool
// freely.
//
// It does not invent the cells that were never measured. A missing
// harness/model pair renders as an explicit "not run" rather than a zero or an
// interpolation, because the sparse grid is itself a finding about what the
// comparison does and does not yet support.
//
// Usage: node bench/harness-comparison.mjs [outfile]

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNS = join(HERE, 'runs');
/**
 * The task the report leads with, and the ones it summarises underneath.
 *
 * `HEADLINE_TASK` is the 28-file migration: long, mechanical, and the one where
 * harness overhead is large enough to measure. The short tasks are a control —
 * if a harness only looks good on the task it was tuned against, that shows up
 * as the two sections disagreeing.
 */
const HEADLINE_TASK = 'multi-file-migration';
const TASK = HEADLINE_TASK;
const SHORT_TASKS = ['bug-fix', 'feature-add', 'refactor', 'iterate'];
/**
 * The realistic one: 45 real TypeScript files with three faults planted, two
 * visible only to the test suite and one only to `tsc`. Every other fixture is
 * small enough for a harness to hold whole, which flatters any approach that
 * front-loads context and never has to search.
 */
const REALISTIC_TASK = 'repo-bugs';

/** Which harness a config name belongs to, and which model it ran on. */
function classify(config, modelFromHeader) {
  if (config.startsWith('pi-') || config === 'pi') return { harness: 'pi', model: modelFromHeader };
  if (config.startsWith('opencode')) return { harness: 'opencode', model: modelFromHeader };
  if (config.startsWith('aider')) return { harness: 'aider', model: modelFromHeader };
  return { harness: 'marshall', model: modelFromHeader };
}

const MODEL_LABEL = {
  'openai/gpt-5.6-luna': 'GPT-5.6 Luna',
  'z-ai/glm-5.3-flash': 'GLM-5.3 Flash',
  'qwen/qwen3.8-flash': 'Qwen3.8 Flash',
};

function collect() {
  const runs = readdirSync(RUNS).filter(d => existsSync(join(RUNS, d, 'results.json'))).sort();
  /** key -> { runId, rows[] } ; latest run wins for marshall, pi/opencode accumulate */
  const byKey = new Map();

  for (const runId of runs) {
    const dir = join(RUNS, runId);
    let models = {};
    try {
      for (const c of JSON.parse(readFileSync(join(dir, 'header.json'), 'utf8')).configs ?? []) {
        if (c && typeof c === 'object') models[c.name] = c.model;
      }
    } catch { /* older runs have no header; those rows are skipped below */ }

    let results;
    try { results = JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8')); } catch { continue; }

    for (const r of results) {
      if (r.task !== TASK && r.task !== REALISTIC_TASK && !SHORT_TASKS.includes(r.task)) continue;
      const model = models[r.config];
      if (!model || !MODEL_LABEL[model]) continue;
      const { harness } = classify(r.config, model);
      const key = `${harness}|${model}|${r.config}|${r.task}`;
      const prev = byKey.get(key);
      // marshall: latest run only. external CLIs: pool every trial.
      if (harness === 'marshall' && prev && prev.runId !== runId) byKey.set(key, { runId, runIds: new Set([runId]), rows: [r] });
      else if (prev) { prev.rows.push(r); prev.runIds.add(runId); prev.runId = runId; }
      else byKey.set(key, { runId, runIds: new Set([runId]), rows: [r] });
    }
  }
  return byKey;
}

/**
 * Which tools a run actually called, read back from the artifacts.
 *
 * This is the part of the comparison that explains the rest: the difference
 * between 37 tool calls and 5 is not that one harness is tighter, it is that
 * one read thirty files individually and the other ran a shell loop. Counts
 * come from each harness's own log — marshall's `session.log`, the external
 * CLIs' `transcript.ndjson` — so no harness is being described in another's
 * vocabulary.
 */
function toolMix(runDirs, cellDirPrefix, task) {
  const mix = {};
  // Every run that contributed a row, so the mix and the call counts describe
  // the same trials — `pi` and `opencode` pool across runs, and reading only
  // one of them would caption one set of numbers with another's behaviour.
  const bases = [];
  for (const runDir of runDirs) {
    try {
      for (const d of readdirSync(join(RUNS, runDir))) {
        // Task included, not just the config: `pi-luna__` is also a prefix of
        // `pi-luna__multi-file-migration-manual__`, and pooling that in
        // captioned this task's counts with another task's behaviour.
        if (d.startsWith(`${cellDirPrefix}__${task}__`)) bases.push(join(RUNS, runDir, d));
      }
    } catch { /* run dir vanished */ }
  }

  for (const base of bases) {
    // marshall logs every call as `TOOL_CALL <caller> <tool> <n>ch {json}`.
    try {
      for (const line of readFileSync(join(base, 'session.log'), 'utf8').split('\n')) {
        const m = /^\S+ \S+ TOOL_CALL \S+ (\w+) /.exec(line) || /TOOL_CALL \S+ (\w+) /.exec(line);
        if (m) mix[m[1]] = (mix[m[1]] ?? 0) + 1;
      }
      continue;
    } catch { /* not a marshall cell */ }
    // pi/opencode emit one `tool_execution_start` per call.
    try {
      for (const line of readFileSync(join(base, 'transcript.ndjson'), 'utf8').split('\n')) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        let e; try { e = JSON.parse(t); } catch { continue; }
        if (e.type !== 'tool_execution_start') continue;
        const name = e.tool ?? e.name ?? e.toolName ?? 'unreported';
        mix[name] = (mix[name] ?? 0) + 1;
      }
    } catch { /* nothing to read */ }
  }
  return mix;
}

const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = xs => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function summarise(byKey) {
  const out = [];
  for (const [key, { runId, runIds, rows }] of byKey) {
    const [harness, model, config, task] = key.split('|');
    const tokened = rows.filter(r => Number.isFinite(r.inputTokens) && r.inputTokens > 0);
    // A timed-out external run reports 0 tool calls because the harness kills
    // the CLI and never parses its transcript — the number is an artifact of
    // giving up, not a measurement. Verified: pi's 420s timeout on
    // qwen/qwen3.8-flash recorded 0 calls against a 4.3 MB transcript holding 9
    // real tool_execution_start events. Averaging that 0 in would have drawn pi
    // as the most economical harness on the model it could not finish at all.
    // marshall counts calls live from its own client, so its timeouts keep
    // real numbers and stay in.
    // Two different reasons a row has no usable count, both of which must stay
    // out of the mean: a timed-out external run reports 0 because it was killed
    // before its transcript was parsed, and aider reports null because it has no
    // tool-calling concept at all. Coercing either to 0 would rank the harness
    // that did the least measurable work first.
    const counted = rows.filter(r =>
      r.toolCalls !== null && r.toolCalls !== undefined && !(r.timedOut && r.toolCalls === 0));
    const costed = rows.filter(r => Number.isFinite(r.costUsd) && r.costUsd > 0);
    out.push({
      harness, model, config, task, runId,
      trials: rows.length,
      passed: rows.filter(r => r.pass).length,
      timedOut: rows.filter(r => r.timedOut).length,
      calls: counted.length ? mean(counted.map(r => r.toolCalls)) : null,
      callsPartial: counted.length !== rows.length,
      callsRange: counted.length ? [Math.min(...counted.map(r => r.toolCalls)), Math.max(...counted.map(r => r.toolCalls))] : null,
      seconds: median(rows.map(r => r.durationMs / 1000)),
      secondsRange: [Math.min(...rows.map(r => r.durationMs / 1000)), Math.max(...rows.map(r => r.durationMs / 1000))],
      inTok: tokened.length ? mean(tokened.map(r => r.inputTokens)) : null,
      outTok: tokened.length ? mean(tokened.map(r => r.outputTokens)) : null,
      costUsd: costed.length ? mean(costed.map(r => r.costUsd)) : null,
      mix: toolMix(runIds, config, task),
      perTrial: rows.map(r => ({
        pass: r.pass, timedOut: !!r.timedOut, calls: r.toolCalls ?? null,
        seconds: r.durationMs / 1000, inTok: r.inputTokens ?? null, outTok: r.outputTokens ?? null,
        costUsd: Number.isFinite(r.costUsd) && r.costUsd > 0 ? r.costUsd : null,
      })),
    });
  }
  return out.sort((a, b) => a.model.localeCompare(b.model) || a.harness.localeCompare(b.harness) || a.config.localeCompare(b.config));
}

const allRows = summarise(collect());
const rows = allRows.filter(r => r.task === HEADLINE_TASK);
const shortRows = allRows.filter(r => SHORT_TASKS.includes(r.task));
const realRows = allRows.filter(r => r.task === REALISTIC_TASK);
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(allRows, null, 2));
  process.exit(0);
}

// Best marshall config per model, plus every external row — that is the
// comparison the page leads with. Marshall's other configs stay in the table
// underneath, since "which marshall config" is the whole story of how it got
// there and dropping it would overstate the result.
const best = new Map();
for (const r of rows.filter(r => r.harness === 'marshall')) {
  const cur = best.get(r.model);
  if (!cur || r.passed / r.trials > cur.passed / cur.trials
    || (r.passed / r.trials === cur.passed / cur.trials && (r.calls ?? Infinity) < (cur.calls ?? Infinity))) best.set(r.model, r);
}

const PALETTE = { marshall: ['#2a78d6', '#3987e5'], pi: ['#eb6834', '#d95926'], opencode: ['#1baf7a', '#199e70'], aider: ['#eda100', '#c98500'] };
const HARNESSES = ['marshall', 'pi', 'opencode', 'aider'];
const MODELS = Object.keys(MODEL_LABEL);

const headline = [];
for (const model of MODELS) {
  for (const h of HARNESSES) {
    const r = h === 'marshall' ? best.get(model) : rows.find(x => x.harness === h && x.model === model);
    headline.push({ model, harness: h, r: r ?? null });
  }
}

const wantsMd = process.argv.includes('--md');
const outArg = process.argv.slice(2).find(a => !a.startsWith('--'));
const out = outArg ?? join(HERE, wantsMd ? 'harness-comparison.md' : 'harness-comparison.html');
writeFileSync(out, wantsMd ? renderMarkdown({ headline, rows }) : render({ headline, rows }));
console.log(`wrote ${out} — ${rows.length} config/model cells, ${rows.reduce((a, r) => a + r.trials, 0)} trials`);

// ── markdown ────────────────────────────────────────────────────────────────
//
// Same data, same refusals as the HTML: no pooling across code states, no
// invented cells, no zero standing in for a number that was never measured.
// Plain CommonMark with no front matter, so it drops into any site generator.
function renderMarkdown({ headline, rows }) {
  const cell = r => {
    if (!r) return '_not run_';
    // Two different reasons a count is missing, and they must not read alike.
    // Every trial timing out means we never got a number; a harness with no
    // tool-calling concept ran perfectly well and the metric does not apply.
    // Rendering aider's runs as "timed out" was wrong on both counts — it
    // finished in 87s and simply changed nothing.
    if (r.calls === null && r.timedOut === r.trials) return `⏱ _timed out_ · 0/${r.trials}`;
    const calls = r.calls === null ? '_n/a_' : `**${r.calls.toFixed(1)}** calls`;
    return `${calls} · ${r.seconds.toFixed(0)}s · ${r.passed}/${r.trials}`;
  };
  const at = (model, harness) => headline.find(d => d.model === model && d.harness === harness)?.r ?? null;

  const grid = [
    `| model | ${HARNESSES.join(' | ')} |`,
    `|${'---|'.repeat(HARNESSES.length + 1)}`,
    ...MODELS.map(m => `| **${MODEL_LABEL[m]}** | ${HARNESSES.map(h => cell(at(m, h))).join(' | ')} |`),
  ].join('\n');

  const n = (v, d = 0) => v === null || v === undefined ? '—' : Math.round(v).toLocaleString('en-US');
  const money = v => v === null || v === undefined ? '—' : `$${v.toFixed(4)}`;
  const range = r => r ? (r[0] === r[1] ? `${r[0]}` : `${r[0]}–${r[1]}`) : '—';

  const detail = [
    '| harness | model | configuration | passed | calls | call range | median s | s range | in tok | out tok | $/run | run |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|',
    ...rows.map(r => `| ${r.harness} | ${MODEL_LABEL[r.model]} | \`${r.config}\` | ${r.passed}/${r.trials}`
      + `${r.timedOut ? ` ⏱${r.timedOut}` : ''} | ${r.calls === null ? '—' : r.calls.toFixed(1) + (r.callsPartial ? '\\*' : '')}`
      + ` | ${range(r.callsRange)} | ${r.seconds.toFixed(1)}`
      + ` | ${r.secondsRange[0].toFixed(0)}–${r.secondsRange[1].toFixed(0)}`
      + ` | ${n(r.inTok)} | ${n(r.outTok)} | ${money(r.costUsd)} | \`${r.runId.slice(0, 19)}\` |`),
  ].join('\n');

  // What each harness actually *did*, which is the part that explains the
  // counts. Sorted by frequency, capped so one long tail cannot dominate.
  const mixRows = rows
    .filter(r => Object.keys(r.mix).length > 0)
    .map(r => {
      const total = Object.values(r.mix).reduce((a, b) => a + b, 0);
      const parts = Object.entries(r.mix).sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `\`${k}\` ${v} (${Math.round((v / total) * 100)}%)`);
      const note = r.timedOut === r.trials ? ' ⏱' : '';
      return `| ${r.harness} | \`${r.config}\`${note} | ${r.trials} | ${total} | ${parts.join(', ')} |`;
    }).join('\n');

  const noMix = rows.filter(r => Object.keys(r.mix).length === 0)
    .map(r => `\`${r.config}\``);

  // Every individual trial, because the aggregates hide how noisy this is.
  const trialRows = rows.flatMap(r => r.perTrial.map((t, i) =>
    `| \`${r.config}\` | ${i + 1} | ${t.timedOut ? '⏱ timeout' : t.pass ? 'pass' : 'fail'} `
    + `| ${t.calls ?? '—'} | ${t.seconds.toFixed(1)} | ${n(t.inTok)} | ${n(t.outTok)}`
    + ` | ${t.calls && t.inTok ? Math.round(t.inTok / t.calls).toLocaleString('en-US') : '—'}`
    + ` | ${money(t.costUsd)} |`)).join('\n');

  const totalTrials = allRows.reduce((a, r) => a + r.trials, 0);

  // The realistic task, and the one that reverses the migration's conclusion.
  const realSection = realRows.length === 0 ? '' : `
## A realistic codebase

Every fixture above is small enough that a harness can hold all of it at once. That flatters any
approach which front-loads context and never has to search, so it is worth one task where finding
the work *is* the work.

\`repo-bugs\` is 45 real TypeScript files — marshall's own \`packages/tools\` — with three faults
planted in them: an off-by-one in a shared line-window primitive, an inverted glob guard in search,
and a type error in a function no test executes. 248 tests, of which exactly 2 fail. Nothing in the
prompt names the faulty files, the failing tests are not all in the files that cause them, and the
type error is invisible to the test run, so the verifier requires both a green suite and a clean
\`tsc\`.

| harness | configuration | passed | calls | median s | in tok | out tok | $/run |
|---|---|---:|---:|---:|---:|---:|---:|
${realRows
    .sort((a, b) => (b.passed / b.trials) - (a.passed / a.trials) || (a.inTok ?? 1e9) - (b.inTok ?? 1e9))
    .map(r => `| ${r.harness} | \`${r.config}\` | ${r.passed}/${r.trials} | ${r.calls === null ? 'n/a' : r.calls.toFixed(1)}`
      + ` | ${r.seconds.toFixed(1)} | ${n(r.inTok)} | ${n(r.outTok)} | ${money(r.costUsd)} |`).join('\n')}

Two things reverse here.

**aider does nothing at all.** ${(() => {
  const a = realRows.find(r => r.harness === 'aider');
  return a ? `${a.passed}/${a.trials}, ${n(a.inTok)} input tokens, ${a.seconds.toFixed(0)}s` : 'It failed every trial';
})()} — and the fixture came back byte-identical, the same 2 of 248 tests failing. It is not running
out of budget; it is declining to start. Its repo-map ships with the instruction *"treat them as
read-only — if you need to edit any of these files, ask me to add them to the chat first"*, because
the map exists for a **human** to read and then name the files. Given \`--yes-always -m\` there is
nobody to answer. On the two-file fixtures it worked because there was nothing to choose. That is
the whole of its 20× economy on small tasks: a person doing the file selection.

**And the reduced belt loses to the plain one.** ${(() => {
  const d = realRows.find(r => r.config.endsWith('-openrouter'));
  const se = realRows.find(r => r.config.endsWith('-shell-edit'));
  if (!d || !se) return '';
  return `\`${se.config}\` spends ${n(se.inTok)} input tokens and ${se.seconds.toFixed(0)}s against `
    + `\`${d.config}\`'s ${n(d.inTok)} and ${d.seconds.toFixed(0)}s, for the same ${d.passed}/${d.trials}.`;
})()} It won the migration by 3×, lost the short tasks, and loses here — which is the argument
against shipping it as a default, made a third time on a third task shape.
`;

  // The short tasks, as a control on the long one. Grouped by task so a
  // harness that only wins where it was tuned has nowhere to hide.
  const shortByTask = {};
  for (const r of shortRows) (shortByTask[r.task] ??= []).push(r);
  const shortSection = Object.keys(shortByTask).length === 0 ? '' : `
## The short tasks, as a control

Everything above is one long, mechanical task. That is the shape where harness overhead is large
enough to measure — and also the shape a harness can be over-fitted to. These are the short ones:
a one-line bug fix, adding a function, a rename across a few files, and an iterative fix. Same
harnesses, same models, same verifiers.

| task | harness | configuration | passed | calls | median s | in tok | out tok |
|---|---|---|---:|---:|---:|---:|---:|
${Object.entries(shortByTask).flatMap(([task, rs]) => rs
    .sort((a, b) => a.harness.localeCompare(b.harness) || a.config.localeCompare(b.config))
    .map(r => `| ${task} | ${r.harness} | \`${r.config}\` | ${r.passed}/${r.trials}`
      + `${r.timedOut ? ` ⏱${r.timedOut}` : ''} | ${r.calls === null ? '—' : r.calls.toFixed(1)}`
      + ` | ${r.seconds.toFixed(1)} | ${n(r.inTok)} | ${n(r.outTok)} |`)).join('\n')}

${(() => {
  const byHarnessConfig = {};
  for (const r of shortRows) {
    const k = r.config;
    (byHarnessConfig[k] ??= { harness: r.harness, passed: 0, trials: 0, out: [] });
    byHarnessConfig[k].passed += r.passed;
    byHarnessConfig[k].trials += r.trials;
    if (r.outTok !== null) byHarnessConfig[k].out.push(r.outTok);
  }
  const line = Object.entries(byHarnessConfig)
    .map(([c, v]) => `\`${c}\` ${v.passed}/${v.trials}`).join(', ');
  const broken = Object.entries(byHarnessConfig).filter(([, v]) => v.passed < v.trials);
  if (broken.length === 0) {
    return `Across all four, every harness passed everything (${line}). On work this small the tool layer
barely matters — which is itself the finding: it earns its keep on long mechanical work and is close
to irrelevant on a one-file fix.`;
  }
  const names = broken.map(([c]) => `\`${c}\``).join(' and ');
  const isare = broken.length === 1 ? 'is the only configuration' : 'are the only configurations';
  return `Across all four: ${line}.

**This is where the reduced belt stops looking good.** ${names} ${isare} to fail anything here, while marshall's default belt, pi and opencode each went clean. The failures are not
subtle: on a task the default belt finishes in ~10 seconds and ~320 output tokens, the reduced belt
twice ran to ~16,000 output tokens and truncated its own tool call mid-JSON, having made two calls
total. Taking \`read_file\` away removes the cheap way to look at a small file, and the model
sometimes substitutes one enormous edit instead.

So the belt that wins the migration task by 3× is also the one that breaks on trivial work. That is
a straightforward argument against shipping it as a default, and the reason it stays a benchmark
row.`;
})()}
`;
  const lunaM = at('openai/gpt-5.6-luna', 'marshall'), lunaP = at('openai/gpt-5.6-luna', 'pi');
  const lunaO = at('openai/gpt-5.6-luna', 'opencode');

  // Every figure quoted in the prose below is looked up here rather than typed.
  // These moved four times in two days — an earlier draft still said "18.7 -> 5.0"
  // and "3/3" after a rerun had made them 14.3, 5.7 and 2/3, which is precisely
  // the drift a generated page is supposed to make impossible.
  const byConfig = Object.fromEntries(rows.map(r => [r.config, r]));
  const q = (config, field, digits = 1) => {
    const r = byConfig[config];
    if (!r || r[field] === null || r[field] === undefined) return '—';
    return typeof r[field] === 'number' ? r[field].toFixed(digits).replace(/\.0$/, '') : String(r[field]);
  };
  const score = config => byConfig[config] ? `${byConfig[config].passed}/${byConfig[config].trials}` : '—';
  const mixOf = (config, tool) => {
    const r = byConfig[config];
    if (!r) return '—';
    const total = Object.values(r.mix).reduce((a, b) => a + b, 0);
    return total ? String(r.mix[tool] ?? 0) : '—';
  };
  const worst = rows.filter(r => r.calls !== null).reduce((a, b) => (a.calls > b.calls ? a : b));
  const bestLuna = lunaM;

  return `# Three coding agents on the same task

I benchmarked [Marshall](https://github.com/agentionai/marshall) against two other open-source
coding agents — [\`pi\`](https://github.com/earendil-works/pi) and
[\`opencode\`](https://github.com/sst/opencode) — on identical work, and spent a day trying to
close the gap where they were ahead.

## The task

A 28-file JavaScript project is halfway through a logging migration. A \`MIGRATION.md\` describes
the rules. Every remaining call site has to move off the deprecated \`log()\` helper, the old module
has to be deleted, and \`node --test\` has to pass afterwards — 122 tests that grade the result.

Every harness gets the same fixture, the same prompt, and the same \`check()\`. No harness is told
*how* to do it: reading every file one at a time and scripting the whole thing in one shot are both
allowed, and which one a harness picks turns out to be most of the story.

## Results

${grid}

⏱ = every trial hit the 7-minute ceiling. _n/a_ under calls = the harness has no tool-calling
concept, not zero: aider applies SEARCH/REPLACE blocks from its own reply rather than calling tools.
${totalTrials} trials total; means for calls, medians for time.

Three things worth pulling out.

**Marshall is the leanest of the three on Luna** — ${lunaM ? lunaM.calls.toFixed(1) : '—'} tool calls against pi's ${lunaP ? lunaP.calls.toFixed(1) : '—'} and opencode's ${lunaO ? lunaO.calls.toFixed(1) : '—'}, at ${lunaM ? `${lunaM.passed}/${lunaM.trials}` : '—'} correctness and ${lunaM && lunaO ? `${(lunaO.seconds / lunaM.seconds).toFixed(1)}×` : '—'} faster than opencode by median run.

**Marshall is the only one that finishes Qwen3.8 Flash.** pi and opencode timed out on every attempt between them (${(byConfig['pi-qwen38flash']?.trials ?? 0) + (byConfig['opencode-qwen38flash']?.trials ?? 0)} in total); Marshall completed ${score('qwen38flash-or-shell-edit')}.

**pi is still ahead on GLM-5.3 Flash** — ${q('pi-glm', 'calls')} calls to Marshall's ${q('glm-shell-edit', 'calls')}, and faster by median run (${q('pi-glm', 'seconds')}s against ${q('glm-shell-edit', 'seconds')}s). One model out of three, and I did not close it.

## Every configuration measured

The Marshall rows are not one number. Its behaviour moved a long way in a day, and the spread
between configurations is larger than the gap between the harnesses:

${detail}

\\* averaged over only the trials that produced a usable count.

## What each harness actually did

Call counts say how many round trips; this says what they were spent on. It is the part that
explains the rest — the distance between ${q('glm-hybrid-batch-prompt', 'calls')} calls and
${q('luna-shell-edit', 'calls')} is not tidiness, it is one harness reading files one at a time
(\`read_file\` ${mixOf('glm-hybrid-batch-prompt', 'read_file')} of its
${Object.values(byConfig['glm-hybrid-batch-prompt']?.mix ?? {}).reduce((a, b) => a + b, 0)} calls) and another
running a shell loop (\`run_shell\` ${mixOf('luna-shell-edit', 'run_shell')} of
${Object.values(byConfig['luna-shell-edit']?.mix ?? {}).reduce((a, b) => a + b, 0)}).

| harness | configuration | trials | calls | composition |
|---|---|---:|---:|---|
${mixRows}

${noMix.length ? `No composition recoverable for ${noMix.join(', ')} — \`opencode\` writes no
transcript this harness can read, so its calls are counted but not categorised.` : ''}

Three patterns are visible in that table.

- **\`pi\` runs almost everything through \`bash\`.** Its own \`read\` tool is a minority of its
  calls; the bulk is shell, including a \`for f in $(grep -rl …); do cat "$f"; done\` that ingests
  every relevant file in one call.
- **Marshall's default belt spreads the same work across four tools** — \`read_file\`, \`search\`,
  \`list_dir\` and \`run_shell\` — and the \`read_file\` share is where its extra calls live.
- **The reduced belt collapses to \`run_shell\`** — 100% of calls on Luna, 95% on GLM. On those two
  the model then does what \`pi\` does and the call count follows. On Qwen3.8 Flash it does not: the
  belt still pushes it mostly to shell, but it issues ${q('qwen38flash-or-shell-edit', 'calls')} calls
  doing so rather than ${q('luna-shell-edit', 'calls')}. Same belt, same instruction, different model.

Rows marked ⏱ timed out on every trial. Their composition is still real — it is what the harness
did before the ceiling — but it is a partial run, which is why the tables above report no call
count for them.

## Every trial, individually

The aggregates above hide how noisy this is. Identical inputs, three trials:

| configuration | trial | result | calls | seconds | in tok | out tok | in tok/call | $ |
|---|---:|---|---:|---:|---:|---:|---:|---:|
${trialRows}

Some of these spreads are larger than the differences between harnesses. That is the single most
important thing to hold in mind when reading any of the numbers above.

${realSection}${shortSection}
## What actually moved the needle

Starting from ${worst.calls.toFixed(0)} tool calls at the worst (\`${worst.config}\`) and
${bestLuna ? bestLuna.calls.toFixed(1) : '—'} at the best (\`${bestLuna ? bestLuna.config : '—'}\`):

- **Batching the file tools** (\`edits[]\` on edit, \`patterns[]\` on search, \`paths[]\` on list) —
  real, but small. It targeted \`search\` and \`list_dir\`, which together were
  ${Number(mixOf('glm-hybrid-batch-prompt', 'search')) + Number(mixOf('glm-hybrid-batch-prompt', 'list_dir'))}
  of that config's ${Object.values(byConfig['glm-hybrid-batch-prompt']?.mix ?? {}).reduce((a, b) => a + b, 0)} calls.
- **Dropping the read-before-edit gate** — larger. Marshall required a \`read_file\` before any
  edit; the \`oldString\` already has to match exactly once, so the gate bought no safety and cost a
  round trip per file. On GLM this took a run from ${q('glm-hybrid-batch-prompt', 'calls')} calls to
  ${q('glm-openrouter', 'calls')}.
- **Pointing bulk reads at the shell** — largest. One \`grep -rl PATTERN src | xargs cat\` replaces
  thirty \`read_file\` calls. This only became honest advice *after* the gate came out, since shell
  output is now enough to edit from. Together the two took a GLM run from
  ${q('glm-hybrid-batch-prompt', 'calls')} calls at ${score('glm-hybrid-batch-prompt')} to
  ${q('glm-openrouter', 'calls')} at ${score('glm-openrouter')}.
- **Cutting the tool belt** to shell + edit + write — biggest single effect on Luna
  (${q('luna-openrouter', 'calls')} → ${q('luna-shell-edit', 'calls')}), smaller on GLM
  (${q('glm-openrouter', 'calls')} → ${q('glm-shell-edit', 'calls')}), and *none at all* on
  Qwen3.8 Flash (${q('qwen38flash-or-solo', 'calls')} → ${q('qwen38flash-or-shell-edit', 'calls')}).
  Not shipped as a default for exactly that reason.

**Masking made things worse, and the mechanism is legible.** Marshall replaces tool results older
than a few turns with a marker the model can fetch back via \`retrieve_tool_result\`, to keep long
conversations small. Measured on the migration with masking on against off:
${(() => {
  const on = byConfig['luna-openrouter'], off = byConfig['luna-nomask'];
  if (!on || !off) return 'the A/B has not been run.';
  return `${on.calls.toFixed(1)} calls and ${n(on.inTok)} input tokens with it on, against `
    + `${off.calls.toFixed(1)} and ${n(off.inTok)} with it off — the same tokens, ${(on.calls - off.calls).toFixed(1)} more calls, `
    + `and ${(on.seconds - off.seconds).toFixed(0)}s slower.`;
})()} Reading the tool logs explains it: \`retrieve_tool_result\` was called **zero** times across
107 runs and 4,012 tool calls, while \`read_file\` ran 6.0 times per masked run against 1.7
unmasked. The model does not use the retrieval tool it is given — it simply re-reads the file. The
content returns to the context anyway, and a round trip is spent putting it there. Masking pays
calls to save context it does not end up saving.

And what did not: four different system-prompt variants. One of them — telling the model to work
incrementally rather than reading everything first — made things dramatically *worse*, pushing it
to ${q('luna-incremental-prompt', 'calls')} calls, of which
${mixOf('luna-incremental-prompt', 'edit_file')} were single \`edit_file\` calls and
${mixOf('luna-incremental-prompt', 'read_file')} were \`read_file\`. Prompt wording moved between
models and never transferred.

## Caveats

I would rather state these than have someone find them.

- **One task, one fixture.** Everything here is the migration task. A harness tuned on one fixture
  is tuned on one fixture.
- **Small samples.** Two to five trials per cell. Trial-to-trial variance is large — one Marshall
  configuration's call counts ranged ${range(byConfig['luna-openrouter']?.callsRange)} across
  ${byConfig['luna-openrouter']?.trials ?? '—'} trials on identical inputs. Treat gaps under ~20% as noise.
- **Marshall is the home team.** I wrote the harness these numbers come from, and I had its
  internals available to tune while treating the others as black boxes. The comparison is
  like-for-like on task, model and grading; it is not like-for-like on effort spent.
- **opencode reports no token usage** through its CLI, so those cells are blank rather than zero.
- **Timed-out external runs have no usable call count.** The harness kills the CLI before parsing
  its transcript and records zero. That is an artifact: pi's timed-out Qwen run left a 4.3 MB
  transcript containing 9 real tool calls. Averaging it in would have drawn pi as the most
  economical harness on the one model it could not finish. Those cells are marked, not counted.
- **Marshall rows come from their latest run only.** Its behaviour changed several times in a day,
  so pooling every trial would describe no version that ever existed.

## Reproducing it

\`\`\`bash
export OPENROUTER_API_KEY=sk-or-...
npx tsx bench/run.ts --config luna-shell-edit --config pi-luna --config opencode-luna \\
  --task multi-file-migration --trials 3
node bench/harness-comparison.mjs --md
\`\`\`

The harness, fixtures and verifier are in \`bench/\`. This page is generated from the run artifacts
rather than written by hand, so it cannot drift from the numbers it reports.
`;
}

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function render({ headline, rows }) {
  const scaleOf = metric => Math.max(...headline
    .filter(d => d.r && d.r[metric] !== null && d.r[metric] !== undefined)
    .map(d => d.r[metric]));
  const maxCalls = scaleOf('calls');
  const maxSecs = scaleOf('seconds');

  const bars = (metric, max, fmt, unit) => MODELS.map(model => {
    const group = headline.filter(d => d.model === model);
    return `<div class="group">
      <div class="group-label">${esc(MODEL_LABEL[model])}</div>
      <div class="bars">
        ${group.map(({ harness, r }) => {
          const label = `<span class="hname">${harness}</span>`;
          if (!r) return `<div class="row">${label}<div class="track"><div class="notrun">not run</div></div></div>`;
          const v = r[metric];
          // Never draw a bar for a number we do not have. A cell whose only
          // trials timed out has no usable call count (see summarise), and a
          // zero-length bar would read as "did it in no calls".
          if (v === null || v === undefined) {
            // "Timed out" and "the metric does not apply" are different facts.
            // aider finished in 87s and changed nothing; calling that a timeout
            // would be simply false.
            const why = r.timedOut === r.trials
              ? { label: 'timed out — not measured', tip: `every trial timed out (${r.timedOut}/${r.trials})` }
              : { label: `n/a — no tool calls · ${r.passed}/${r.trials}`, tip: 'this harness has no tool-calling concept' };
            return `<div class="row" tabindex="0" data-tip="${esc(harness)} · ${esc(MODEL_LABEL[model])}\n${esc(why.tip)}\nconfig: ${esc(r.config)}">
              ${label}<div class="track"><div class="notrun">${esc(why.label)}</div></div></div>`;
          }
          const pct = Math.max(1.5, (v / max) * 100);
          const failed = r.passed < r.trials;
          return `<div class="row" tabindex="0"
              data-tip="${esc(harness)} · ${esc(MODEL_LABEL[model])}\n${fmt(v)}${unit}\n${r.passed}/${r.trials} passed${r.timedOut ? ` · ${r.timedOut} timed out` : ''}\nconfig: ${esc(r.config)}">
            ${label}
            <div class="track"><div class="bar h-${harness}" style="width:${pct}%"></div><span class="val">${fmt(v)}${unit}${failed ? ` <span class="warn">${r.passed}/${r.trials}</span>` : ''}</span></div>
          </div>`;
        }).join('')}
      </div></div>`;
  }).join('');

  const tableRows = rows.map(r => `<tr>
    <td><span class="dot h-${r.harness}"></span>${esc(r.harness)}</td>
    <td>${esc(MODEL_LABEL[r.model])}</td>
    <td class="mono">${esc(r.config)}</td>
    <td class="num">${r.passed}/${r.trials}${r.timedOut ? `<span class="warn" title="${r.timedOut} timed out"> ⏱${r.timedOut}</span>` : ''}</td>
    <td class="num">${r.calls === null ? '<span class="na">n/a</span>' : r.calls.toFixed(1) + (r.callsPartial ? '<span class="warn">*</span>' : '')}</td>
    <td class="num">${r.seconds.toFixed(1)}</td>
    <td class="num">${r.inTok === null ? '<span class="na">n/a</span>' : Math.round(r.inTok).toLocaleString()}</td>
    <td class="num">${r.outTok === null ? '<span class="na">n/a</span>' : Math.round(r.outTok).toLocaleString()}</td>
    <td class="mono tiny">${esc(r.runId)}</td></tr>`).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Coding agent comparison — multi-file-migration</title>
<style>
:root{
  --surface:#fcfcfb; --plane:#f9f9f7; --ink:#0b0b0b; --ink2:#52514e; --muted:#898781;
  --grid:#e1e0d9; --axis:#c3c2b7; --border:rgba(11,11,11,0.10);
  --marshall:#2a78d6; --pi:#eb6834; --opencode:#1baf7a; --aider:#eda100;
}
@media (prefers-color-scheme:dark){:root{
  --surface:#1a1a19; --plane:#0d0d0d; --ink:#fff; --ink2:#c3c2b7; --muted:#898781;
  --grid:#2c2c2a; --axis:#383835; --border:rgba(255,255,255,0.10);
  --marshall:#3987e5; --pi:#d95926; --opencode:#199e70; --aider:#c98500;
}}
*{box-sizing:border-box}
body{margin:0;background:var(--plane);color:var(--ink);
  font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:40px 24px}
.wrap{max-width:1080px;margin:0 auto}
h1{font-size:24px;margin:0 0 6px;letter-spacing:-.01em}
.sub{color:var(--ink2);margin:0 0 28px;max-width:70ch}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:22px 24px;margin-bottom:22px}
h2{font-size:16px;margin:0 0 4px}
.hint{color:var(--muted);font-size:13px;margin:0 0 18px}
.legend{display:flex;gap:18px;flex-wrap:wrap;margin:0 0 20px;font-size:13px;color:var(--ink2)}
.legend span{display:inline-flex;align-items:center;gap:7px}
.sw{width:11px;height:11px;border-radius:3px;display:inline-block}
.group{margin-bottom:20px}
.group:last-child{margin-bottom:0}
.group-label{font-size:12px;font-weight:600;color:var(--ink2);letter-spacing:.02em;margin-bottom:8px;
  padding-bottom:6px;border-bottom:1px solid var(--grid)}
.row{display:flex;align-items:center;gap:10px;margin-bottom:5px;outline:none;border-radius:4px}
.row:hover,.row:focus{background:color-mix(in srgb,var(--muted) 9%,transparent)}
.hname{width:74px;flex:none;font-size:12px;color:var(--muted);text-align:right}
.track{position:relative;flex:1;display:flex;align-items:center;gap:9px;height:22px}
.bar{height:13px;border-radius:0 4px 4px 0;box-shadow:0 0 0 2px var(--surface)}
.h-marshall{background:var(--marshall)} .h-pi{background:var(--pi)} .h-opencode{background:var(--opencode)} .h-aider{background:var(--aider)}
.val{font-size:12.5px;color:var(--ink2);font-variant-numeric:tabular-nums}
.notrun{font-size:12px;color:var(--muted);font-style:italic}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-weight:600;color:var(--ink2);border-bottom:1px solid var(--axis);padding:7px 9px;font-size:12px}
td{padding:7px 9px;border-bottom:1px solid var(--grid);color:var(--ink2)}
.num{text-align:right;font-variant-numeric:tabular-nums}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px}
.tiny{color:var(--muted);font-size:10.5px}
.na{color:var(--muted)}
.warn{color:var(--pi);font-size:11px;font-variant-numeric:tabular-nums}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:7px}
#tip{position:fixed;pointer-events:none;opacity:0;transition:opacity .1s;background:var(--ink);
  color:var(--surface);padding:8px 11px;border-radius:7px;font-size:12px;white-space:pre-line;z-index:9;max-width:280px}
.note{font-size:12.5px;color:var(--muted);margin-top:14px;padding-top:12px;border-top:1px solid var(--grid)}
</style></head><body data-palette="#2a78d6,#eb6834,#1baf7a,#eda100"><div class="wrap">

<h1>Coding agents on the same task</h1>
<p class="sub">${HARNESSES.length} harnesses run the identical 28-file logging migration, from identical
fixtures, graded by the identical <code>check()</code> — 122 tests that must pass. Lower is better on
both charts. Each bar is the mean (calls) or median (time) of that cell's trials. <em>n/a</em> means
the harness has no such metric, not zero.</p>

<div class="card">
  <h2>Tool calls per run</h2>
  <p class="hint">How many round trips to the model it took. The metric the harness controls most directly.</p>
  <div class="legend">
    ${HARNESSES.map(h => `<span><i class="sw h-${h}"></i>${h}</span>`).join('')}
  </div>
  ${bars('calls', maxCalls, v => v.toFixed(1), '')}
</div>

<div class="card">
  <h2>Wall-clock time</h2>
  <p class="hint">Median seconds per run. Dominated by how fast and how verbosely the model generates.</p>
  <div class="legend">
    ${HARNESSES.map(h => `<span><i class="sw h-${h}"></i>${h}</span>`).join('')}
  </div>
  ${bars('seconds', maxSecs, v => v.toFixed(0), 's')}
</div>

<div class="card">
  <h2>Every measured cell</h2>
  <p class="hint">All marshall configurations, not just the best one — the spread between them is
  most of what this exercise found.</p>
  <table>
    <thead><tr><th>harness</th><th>model</th><th>config</th><th class="num">pass</th>
      <th class="num">calls</th><th class="num">sec</th><th class="num">in tok</th>
      <th class="num">out tok</th><th>run</th></tr></thead>
    <tbody>${tableRows}</tbody>
  </table>
  <p class="note"><strong>Reading this honestly.</strong> marshall cells come from their latest run
  only — its behaviour changed several times in one day, so pooling every trial would describe no
  version that ever existed. <code>pi</code> and <code>opencode</code> are external CLIs unaffected
  by those changes, so their trials pool. <code>opencode</code> reports no token usage through its
  CLI, hence <span class="na">n/a</span>. Blank cells were never run rather than zero. A cell whose every
  trial timed out has no usable call count at all: the external CLIs are killed before their
  transcript is parsed, so the harness records 0 — verified as an artifact, since pi's timed-out
  Qwen run left a 4.3 MB transcript containing 9 real tool calls. Those cells read
  <em>timed out — not measured</em> rather than zero, and <span class="warn">*</span> marks an
  average taken over only the trials that did produce a count. Trial counts are small (1–5); treat
  gaps under ~20% as noise.</p>
</div>

</div><div id="tip"></div><script>
const tip=document.getElementById('tip');
for(const el of document.querySelectorAll('[data-tip]')){
  const show=e=>{tip.textContent=el.dataset.tip;tip.style.opacity=1;
    const r=el.getBoundingClientRect();
    tip.style.left=Math.min(window.innerWidth-296,(e.clientX??r.left)+14)+'px';
    tip.style.top=((e.clientY??r.top)+16)+'px';};
  el.addEventListener('mousemove',show);
  el.addEventListener('focus',show);
  el.addEventListener('mouseleave',()=>tip.style.opacity=0);
  el.addEventListener('blur',()=>tip.style.opacity=0);
}
</script></body></html>`;
}
