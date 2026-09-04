# Benchmark suite

Runs real tasks against marshall (and, opt-in, `pi`/`opencode`) and scores them with real,
deterministic verifiers — never an LLM judge. An attempt either satisfies its check or it doesn't;
"looked plausible" isn't a passing grade.

## Methodology

Modelled on [Artificial Analysis's coding-agent benchmark](https://artificialanalysis.ai/agents/coding-agents),
scaled to what's practical to run locally:

- **Pass/fail per task, via a real verifier** — a test suite that actually runs (`runNodeTests`,
  `runEngineTests`), or a deterministic check of the agent's answer text (`answerContains`) for a
  question-answering task. No task is scored by asking another model whether the output looks
  right.
- **N trials per (config, task), aggregated to a pass rate** — `--trials 3` runs everything three
  times and reports `passes/trials` alongside averaged cost/time/tool-call figures, because a
  single run says nothing about how consistent an agent is on a task with any real difficulty.
- **The harness is isolated from the model where possible** — the same task, fixture, and prompt
  run through marshall, `pi`, and `opencode`, so a difference in outcome is attributable to the
  agent/tool layer rather than to which model happened to answer.
- **Cost and token usage are tracked alongside pass rate**, not instead of it — a config that
  passes more often but burns 10x the tokens is a real tradeoff, not a strictly better result.

### Where this falls short of a "proper" published benchmark

Worth being honest about, not just aspirational:

- **Small task count** (7, as of this writing) — a real signal on any one task, not yet enough
  volume for the aggregate to mean much statistically. See "Adding a task" below.
- **The per-request instrumentation is local-only.** Everything under "Per-request measurements"
  below comes from llama-server's own logs, so it exists for llamacpp configs and for nothing else.
  A remote provider reports a prompt's size but never how much of it it had to compute.
- **External-harness token counts are partial.** `pi` reports real usage (see below).
  `opencode run` has no working structured-output mode we found — `--format json` produced no
  stdout in testing — so its token counts are unavailable (shown as `-`) and its tool-call count is
  a heuristic (counting `$ ` / `✱`/`✗` prefixed lines in its terminal transcript), not a precise one.
- **Single machine, single point in time.** Model behavior on OpenRouter drifts — the same prompt
  against the same model id can route to a different upstream and answer differently run to run
  (we saw this directly: `pi` and `opencode` each failed `qa-minified-token` on one of two trials
  in the same batch, dropping the `UNIQUE_` prefix from the token). That's what the trials/pass-rate
  reporting exists to surface, not hide.

## Per-request measurements

For configs running against the local llama.cpp router, each run is also measured from
**llama-server's own slot logs** (`journalctl --user -u llama-server`), parsed by
`llama-journal.ts`. This is a different and strictly larger source than the API's `usage` block.

Per provider request:

| field | meaning |
|---|---|
| `contextTokens` | the prompt's size — `n_tokens` at release, minus generated, plus one |
| `recomputedTokens` | how much of that prompt the server actually computed; the rest came from KV cache |
| `reusedPrefixTokens` | `contextTokens - recomputedTokens` |
| `prefixDivergenceTokens` | history that was already sent and then edited — 0 for a clean append |
| `truncated` | whether the server had to drop context to fit the window |
| `fSimBest` | the prefix match the slot scheduler found, 0..1 |
| `evalTps`, `tgSamples` | generation rate: per-request average, and `tg_3s` samples every ~3s |

The distinction that matters: **a large context and an expensive one are different things.** With a
stable prefix, a 48,000-token prompt can cost 28 tokens of prompt eval. The API cannot tell you
that; the journal can. `prefixDivergenceTokens` is what catches a client rewriting history it had
already sent — the thing that turns a cheap prefill into an expensive one.

### Why the `+ 1`, and why you should distrust it until you check

`n_tokens - generated` comes out exactly one token below the API's own `prompt_tokens`, on every
request of every run checked so far. The `+ 1` corrects that, and two independent things fall into
place when it is applied: a cold slot's first request reuses exactly 0 tokens rather than -1, and a
pure append reuses exactly what its predecessor left behind rather than one short of it.

`run.ts` re-checks this on every run — it compares the engine's own token tally against the
journal's and reports `tally: ok` or `tally: MISMATCH` in the metrics table. A MISMATCH means the
journal window caught requests that weren't this run's (or missed some that were), and every
per-request figure for that run should be treated as unreliable.

### Reading the numbers

- **Prefill rate is not comparable across sizes.** A sub-64-token prefill is dominated by fixed
  overhead and measures several times slower than a 4,000-token one on the same machine. Report
  prefill *token counts*, and bucket rates by size — never pool them into one figure.
- **Use `tg_3s`, not `tg`.** The former is instantaneous, the latter a cumulative average that
  flattens exactly the variation worth seeing.
- **Filter to the run window *and* the child port.** The router multiplexes every loaded model into
  one journal; pooled figures across it are meaningless (`tg_3s` pooled over the whole journal has
  a median of 3 tok/s while the model under test held a steady ~52).
- **The box must be yours for the duration.** Slots are assigned by prefix similarity, so a
  concurrent client can land on the same slot and evict the prefix.

Artifacts land in `runs/<ISO>/<config>__<task>__trial<N>/` — `requests.csv`, `tg-samples.csv`,
`api-calls.json`, the engine's `session.log`, and `journal.log`, the raw slice, archived verbatim
because journald rotates (`SystemMaxUse=100M`) and the lines behind a number may be gone by the
time anyone questions it. `node report.mjs runs/<ISO>` renders the lot to a single HTML page.

## Task categories

- **Code-editing** (`bug-fix`, `feature-add`, `refactor`, `iterate`, `real-repo-fix`) — a fixture
  workspace, a prompt, a real test suite that must go green. `real-repo-fix` is the odd one out: a
  full monorepo snapshot rather than a hand-built fixture — see below.
- **Question-answering** (`qa-large-log`, `qa-minified-token`) — no editing; the check reads the
  agent's final chat message. Both fixtures are the exact adversarial shapes that broke a dedicated
  search tool in two other agent harnesses during testing on 2026-08-19 — a file just over the
  read/search byte cap whose only "hit" for a plausible query used to be a stale truncation marker,
  and a single-line minified file whose one interesting token sits deep enough in that naive
  truncation clips past it. See `docs/competitive-findings.md` for what that looked like before the
  fix these two tasks now guard against regressing.

## Running it

```bash
npx tsx run.ts --list                                   # configs, external harnesses, tasks
npx tsx run.ts                                           # every marshall config × every task, 1 trial
npx tsx run.ts --config fast-solo --task bug-fix          # one config, one task
npx tsx run.ts --task qa-large-log --task qa-minified-token --trials 3   # Q&A tasks, 3 trials each
npx tsx run.ts --config ornith-solo --task multi-file-migration-manual --trials 3
npx tsx run.ts --config fast-solo --task bug-fix --timeout 300            # per-task budget, seconds
npx tsx run.ts --config fast-solo --task bug-fix --no-artifacts           # skip the run directory
node report.mjs runs/2026-08-26T09-45-32-139Z                             # render a run to HTML
```

Marshall configs (`config.ts`'s `CONFIGURATIONS`) default to a local `llamacpp` host
(`MARSHALL_BENCH_HOST`, or `http://127.0.0.1:8080`) — point that at whatever you have running,
or edit the list to use a different provider entirely; nothing in the harness assumes llamacpp.

### Running `pi` / `opencode`

Opt-in only — name them explicitly, since they need the real CLIs installed and
`OPENROUTER_API_KEY` set, and bill a real API on every call:

```bash
export OPENROUTER_API_KEY=sk-or-...
npx tsx run.ts --config pi --config opencode --task qa-minified-token --trials 3
```

`config.ts`'s `EXTERNAL_HARNESSES` is where their model is set — same field for both, just the
`provider/model` string each CLI's `--model` flag expects.

`sonnet5-openrouter` and `sonnet5-openrouter-light` in `CONFIGURATIONS` are the same model as the
external harnesses, for a fair same-model comparison — `-light` runs with `EngineConfig.light`
on, which drops every sub-agent tool (`context`/`search`/`planner`/`reviewer`, plus job/scratch/
conflict/swarm tools) down to a single-agent belt. Comparing the two isolates how much of any
input-token gap against `pi`/`opencode` is marshall's tool-schema overhead versus conversation or
read verbosity — see `docs/competitive-findings.md`'s "Tool-schema overhead" section for what one
early run found.

**Both CLIs hang indefinitely — no output, no error, no timeout of their own — when spawned
without a TTY**, which is exactly what Node's `child_process` gives a child by default. Neither
documents this. `external-harness.ts`'s `execViaPty` works around it by running every external
command through `script -qec` (util-linux). That's Linux-specific; BSD/macOS `script` takes
different flags, so this doesn't work unmodified there yet.

### Env vars

- `MARSHALL_BENCH_HOST` — llamacpp host for the default marshall configs.
- `MARSHALL_BENCH_KEEP_FAILED` — don't delete a failing task's workspace, so you can inspect what
  the agent actually did.
- `MARSHALL_BENCH_KEEP_ALL` — keep every workspace, pass or fail.

## Adding a task

**Code-editing:** add a directory under `fixtures/`, add a `BenchTask` to `tasks.ts` with a prompt
and `check: runNodeTests` (or a new check function if the fixture needs something other than
`node --test`).

**Question-answering:** same, but `check: answerContains(/pattern one/, /pattern two/)` — every
pattern must match somewhere in the agent's final response; order and phrasing are free, the
literal facts aren't. Keep the fixture adversarial if the point is regression-testing a specific
failure mode (see `qa-large-log`/`qa-minified-token`'s own comments in `tasks.ts` for why they're
built the way they are) — a fixture a competent agent would pass by default doesn't tell you much
run after run.

Either way: the check function is the whole contract. If you can't write a check that fails on a
wrong answer and passes on a right one without a human or another model reading it, the task isn't
ready to go in this suite yet.

## Regenerating `multi-file-migration`'s fixture

```bash
node scripts/build-migration-fixture.mjs --modules 30
```

Deterministic from a fixed seed, so two runs of the generator produce byte-identical fixtures and
two bench runs stay comparable. `--modules` sets the length of the task.

The task ships in two variants against the same fixture. `multi-file-migration` leaves the approach
open, and a capable model will read a handful of modules, infer the rule from `MIGRATION.md`, and
write a codemod for the rest — which is a legitimate way to do the job, and is what happened on the
first recorded run. `multi-file-migration-manual` asks for direct edits instead. Only the second
exercises the many-reads-and-writes regime the instrumentation was built for; the first is a fair
measure of how a model actually chooses to attack the problem. They answer different questions, so
run both rather than picking one.

## Regenerating `real-repo-fix`'s fixture

Not committed — a full monorepo copy is too large and goes stale the moment source drifts.
Regenerate it locally before running that task:

```bash
bash scripts/build-real-repo-fixture.sh
```

The script copies this repo (excluding `node_modules`/`dist`/`.git`, symlinking `node_modules`
back in rather than reinstalling), introduces one deliberate one-line regression in
`packages/engine/src/usage.ts` (a rounding change in `formatRate`), and **proves the fixture is
correct before leaving it in place** — it runs the engine test suite twice, once on the untouched
copy (must be fully green, or the fixture would start from a lie) and once broken (must be
*exactly* one failing test, no more, no less). If `usage.ts` changes shape and either check stops
holding, the script fails loudly with instructions rather than silently handing you a fixture whose
prompt ("has one failing test") is no longer true.
