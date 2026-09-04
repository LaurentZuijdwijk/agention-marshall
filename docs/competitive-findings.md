# Why the tool layer matters — findings from today's testing

> **Draft, not copy.** This is a working document capturing what we verified today, written to
> be adapted into marketing material — not to be published as-is. Before anything here goes
> public: (1) re-verify the competitor bugs, since they may get patched — everything below is
> dated and version-pinned for that reason; (2) decide whether to name `pi` and `opencode`
> directly or describe them generically; (3) get eyes on any specific numeric claim before it
> ships. Nothing here is fabricated or extrapolated — every claim traces to a live, reproduced
> test, noted inline — but "verified once, today" and "true forever" are different claims, and
> marketing copy tends to blur that line if we're not careful.

## The thesis

A coding agent is only as good as what its tools tell the model. A model that reasons perfectly
over wrong, missing, or misleading tool output still gets the wrong answer — and the failure is
invisible in a demo, because it only shows up on the inputs nobody thought to test: the 480 KB
minified bundle, the log file with a coincidental substring match, the one line that's the whole
file. We spent today stress-testing exactly that layer — in our own tools and, for honest
comparison, in two real competing agent harnesses — against several real models via OpenRouter.

## What we found in competing tools

Reproduced live, not just read from source — each one confirmed by actually running the tool
against a real model and watching it fail, then confirmed again by reading the implementation to
understand why.

**`pi` (v0.79.1) never uses its own dedicated search tool.** Across every trial we ran — four
different models, with and without an explicit instruction to use it — `pi`'s model reached for
raw shell commands (`bash` + `grep`) instead of its purpose-built `grep` tool. It turns out `grep`
isn't even in `pi`'s default toolset (`read`, `bash`, `edit`, `write` only); it has to be opted
into explicitly.

**When we did force `pi` to use its dedicated tool, it did worse than the shell fallback.** In
read-only mode (`--tools read,grep,find,ls`), asked to find a specific token in a 480 KB
single-line file, `pi`'s `grep` tool clips a matched line from the *start*, not centred on the
match. A match 240,000 characters into the line came back as an unbroken wall of filler — the
model could see a match existed but never saw what it matched. Result: 15 tool calls, roughly
30,000 tokens, and a 90-second timeout with no answer. The generic shell fallback (`bash` +
`grep -n`) usually recovered from its own failure mode in a handful of calls; the dedicated tool,
on this input, did not recover at all within the trial.

**`pi`'s shell tool silently reports "no output" instead of "too much output."** When a single
line of command output exceeds its 50 KB cap, `pi`'s `bash` tool returns the literal string
`(no output)` — indistinguishable from a command that genuinely found nothing. We watched a model
spend 8–20 tool calls chasing a phantom "maybe there's an encoding bug" theory before giving up
and working around it with Python, on input that a single correctly-clipped grep result would
have answered immediately.

**`pi`'s own error message tells the model to do something the model can't do.** When a file's
first line alone exceeds the read limit, `pi`'s `read` tool suggests `Use bash: sed -n ...` —
unconditionally, even when `bash` isn't in the toolset being used. Confirmed both in the running
tool's error text and in the source: the fallback string is hardcoded, with no check for whether
the tool it's suggesting actually exists in the current session.

**`opencode` (v1.17.16)'s search tool crashes outright on the same input shape** — twice, on two
different models: `Error: Ripgrep JSON record exceeded 65536 bytes`. Where `pi`'s dedicated tool
degrades badly, `opencode`'s dedicated tool doesn't degrade at all; it errors, and the model falls
back to raw shell commands to recover.

## What we found in ours — and fixed

Two real gaps, both fixed and both tested against the same adversarial inputs that broke the
tools above:

- **A truncation bug in `read_file`** let a single oversized line — a minified bundle, a
  one-line JSON dump — bypass the byte cap entirely and go out uncapped, once even large enough
  to get a request rejected outright by a model's context window. Fixed: an oversized line is now
  clipped to the configured limit like everything else, with a truncation notice that names the
  specific reason (not a generic "read more" hint that doesn't apply to a single-line file).
- **`list_dir` never reported file size**, so a model had no way to know a file was 480 KB before
  spending a call reading it in full. It now does, with guidance to prefer `search` over
  `read_file` for a large file when only part of it is needed.

Verified against the exact fixture that broke `pi`'s and `opencode`'s tools, across four models —
correct, every time, and never crashed or went silently empty. `search` clips a matched line to a
window *centred on the match* rather than truncating from the start, which is the specific defect
that broke `pi`'s dedicated tool.

## Prompt caching: a real, measured cost reduction

Separately from the robustness work: we found the coding session wasn't using Anthropic's prompt
caching via OpenRouter at all — every turn re-sent the full system prompt and tool schemas at
full price, even when nothing about them had changed since the last turn. Fixed and verified live,
three consecutive turns, identical prefix, real API calls:

| turn | cache write | cache read | cost |
|---|---|---|---|
| 1 | 3,746 tokens | — | $0.00955 |
| 2 | — | 3,746 tokens | $0.00096 |
| 3 | — | 3,746 tokens | $0.00098 |

**~10x cheaper from the second turn on**, for every session past the first turn. This isn't a
claim about being ahead of competing tools — some already benefit from caching in ways we haven't
fully audited — it's a real, previously-unrealized cost lever in our own stack, now on.

## Tool-schema overhead: most of the token gap against `pi`, isolated

A same-model, same-task comparison (`anthropic/claude-sonnet-5` via OpenRouter, both harnesses,
`real-repo-fix` bench task — find and fix a real failing test in this repo's own engine package)
initially showed marshall spending noticeably more input tokens than `pi` for an equivalent
result: **52,002 tokens** for marshall vs **43,767** for `pi`, both passing in 5 tool calls.

Re-run with marshall's `light` mode on — which drops the `context`/`search`/`planner`/`reviewer`
sub-agent tools and the job/scratch/conflict/swarm tools down to a single-agent belt (file tools
+ shell only) — marshall dropped to **41,177 input tokens**, *under* `pi`'s 43,548 on the same
re-run. That's a same-model, same-task, same-pass/fail-outcome swing of roughly 11,000 tokens from
one config flag.

The read is: a meaningful share of the earlier gap was schema and delegation-guidance overhead
from sub-agent tools `pi` doesn't have at all, not conversation bloat or verbose tool output. It
does **not** mean light mode is strictly better — the sub-agent tools it drops (planner, reviewer,
a dedicated context/search agent) are capability, not waste, and the fair comparison for a tool
that *has* them is the full-belt number. What this isolates is that the token cost of *having*
that capability, even unused on a task simple enough not to need it, is real and roughly
quantifiable.

**One trial each, so far** — noisy by nature (turn count, exact tokens read, even cache warmth
vary run to run) and not yet a reliable signal on its own. `--trials 5` or more on both the
`sonnet5-openrouter` and `sonnet5-openrouter-light` bench configs against `pi` would turn this
from a promising single data point into a real number.

## How we know this holds up

Every claim above came from actually running the thing, not reading the code and assuming. We
intercepted the real HTTP requests our own agent sends, read the raw response bodies back from
the providers, and ran the competing tools live against the same fixtures and the same models
(`x-ai/grok-4.5`, `anthropic/claude-sonnet-5`, `deepseek/deepseek-v4-flash-0731`,
`inclusionai/ling-3.0-flash`, all via OpenRouter). Several of the numbers above surprised us
mid-investigation and changed the conclusion — that's the point: this was built to falsify our
own assumptions, not confirm them.

## What this doc doesn't claim

Being precise here matters as much as being persuasive. We did **not** find that our tools are
always faster, always cheaper, or always take fewer tool calls than `pi` or `opencode` — on
several trials, particularly with weaker models, ours took more calls for the same simple
question. The claim that holds up is narrower and more defensible: under an adversarial input
that has a real, common shape — a large minified file, a log with a coincidental match — our
tools degrade safely where the two we tested against did not, and we can show exactly why.

The tool-schema-overhead finding above is a single trial on each side and explicitly flagged as
such — treat it as a lead worth confirming with more runs, not a settled number.
