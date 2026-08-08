# Agent-based safety (safety level 3)

Notes on Marshall's LLM-judged tool-call approval gate: how it's built, and, the more
interesting part, what testing it against real local models actually taught us about
using small/guard models as safety judges. Written up for a future article and for the
docs site; treat this as the source material, not the final copy.

## The feature, in one paragraph

Marshall gates every state-changing tool call (`write_file`, `run_shell`, etc.) behind
an approval step. Normally that's a human in a terminal. Safety level 3 inserts a model
in front of the human: a dedicated "judge" reviews the call first. A confident **safe**
verdict approves the call outright, skipping the human entirely. An **unsafe** verdict
does not hard-block, it annotates the approval request with the judge's reasoning and
still asks the human, who can override a false positive. A failed or unparseable judge
call also defers to the human, unannotated. The judge never gets the power to block
something permanently on its own; it only gets the power to skip asking about things it's
confident are fine.

## Architecture

- `EngineConfig.safetyLevel: 1 | 2 | 3` (1 = no gate, 2 = human-in-the-loop, the default,
  3 = agent-based) and `EngineConfig.safetyAgent: { profile: AgentProfile; kind?; maxOutputTokens? }`.
  `profile` is a normal provider/model pick, no dedicated "nvidia" provider was added;
  point `provider: 'openrouter'` (or any OpenAI-compatible host) at whatever judge you want.
- `packages/engine/src/safety-agent.ts` is the whole thing: context builder
  (`buildSafetyContext`), two prompt builders (one per `kind`), a decision parser
  (`parseSafetyVerdict`), and `createSafetyAgentDecider`, which returns an `ApprovalDecider`.
- It slots into `Session.approvalChain()` at a seam that already existed for exactly this
  purpose (the always-approve list, then this, then the human), no tool code had to change.
- `ApprovalRequest.taskContext` carries the user's current instruction (`Session.run(task)`)
  through the same per-belt stamping mechanism `caller` already used, all the way to the
  judge's prompt. Without this the judge cannot tell "the user asked for this deletion"
  apart from "the agent decided to delete this on its own", see the investigation below.
- `/safety [none|default|agentic]` in the CLI; picking `agentic` opens the same model-picker
  wizard used for `/model`, retitled. Deliberately **session-only**, not persisted, matches
  `/light`, not the saved model profile. The startup banner shows a `safety` row when it
  isn't the default, since otherwise a non-default level is invisible after the confirmation
  message scrolls off.
- Every judge call is logged in full (system prompt, user prompt, raw response) to
  `.marshall/logs/session.log`, untruncated. This is what "test in detail and try to
  break it" needs.
- `temperature: 0` on the judge's agent. Non-negotiable, see below.

## The two judge "kinds"

- **`chat-judge`**: a natural-language prompt for a general instruction-following model.
  Asks for `{"decision": "approve"|"deny", "reason": "..."}`.
- **`nvidia-content-safety`**: targets guard/classifier models (NVIDIA's Nemotron
  content-safety family and similar). Uses the actual Llama-Guard/Aegis delimited taxonomy
  format (`<BEGIN UNSAFE CONTENT CATEGORIES>` ... `<BEGIN CONVERSATION>` ...) these models
  were fine-tuned against, with base Aegis categories plus NVIDIA's own "code assistant /
  developer tools" custom-policy additions (malware, vulnerability exploit, unauthorized
  access). Output is the plain `User Safety: safe|unsafe` / `Response Safety: safe|unsafe`
  line format these models natively emit, never JSON, regardless of what you ask for.

These are not interchangeable, and which one wins is not obvious in advance, see below.

## The investigation

This is the part worth writing up properly. Tested against real models on a local
llama.cpp box, not assumed.

### 1. "Is the history really transient?", verified, wasn't the bug

Two safety-judge calls in the same session produced different verdicts for the identical
tool call. The instinct was leaking conversation history between judge calls. Traced it
into the SDK source: `runSafetyJudge` constructs a brand-new `History` object and a
brand-new agent on every single call, there was no shared state to leak in the first
place. The real cause was `MaxTokensExceededError`: the judge's output cap (200 tokens,
tuned for a terse JSON verdict) was too small for a guard model that emits a chain-of-thought
preamble before its verdict, so responses were getting cut off mid-generation. Fixed by
raising the default to 600 and making it configurable
(`SafetyAgentConfig.maxOutputTokens`), and by reporting a truncation distinctly from a
real connectivity failure (`describeJudgeFailure`) instead of calling both "unreachable."

### 2. Determinism: the fix that mattered most

Early A/B comparisons of prompt wordings looked like real signal, until the same
prompt against the same model on a re-run gave a different answer. The model's server
had no explicit `temperature` set, so llama.cpp's non-zero default applied, and every
single-shot comparison up to that point was partly measuring sampling noise. Adding
`temperature: 0` made every subsequent test fully reproducible: 20/20, then 22/22,
scenario/kind pairs gave the identical answer across 3 to 8 repeated trials. This is the
one fix that made every later finding trustworthy. Lesson: never trust a single-run
comparison of an LLM-judge prompt; pin temperature and run multiple trials before
concluding anything moved.

### 3. Fixed classifiers don't read the system prompt as instructions

Once trials were reproducible, category-wording rewrites (tightening a "credential
exposure" category, adding explicit examples) were tested against a real Nemotron
content-safety GGUF. Result: byte-identical output, before and after, across every
scenario. NVIDIA's own usage examples confirmed why: these are fine-tuned classifiers keyed
to a specific structured taxonomy format, not chat models that read a system prompt as
free-form instructions. They also never emit the JSON we were asking for, always a bare
`User Safety: safe|unsafe` line, confirmed both empirically and in NVIDIA's own docs.

### 4. Wrong domain, not a bad model

NVIDIA's own documentation revealed the model's actual trained taxonomy is a
customer-support content-moderation set (Threat, PII/Privacy, Profanity, Social
Engineering, Unauthorized Advice); there is no "destructive operation" or "scope
violation" category in it at all. Its apparent reliability on `rm -rf /` and
curl-pipe-to-sh was very likely pattern-matching on alarming-looking strings, not genuine
understanding that they're destructive filesystem operations. This explained why no
amount of prompt tightening moved the needle: we were asking a customer-support-chat
classifier to do agentic tool-call review, a task outside what it was ever trained for.

### 5. Applying the actual documented pattern, still capped

NVIDIA's docs describe a "code assistant / developer tools" policy archetype and a
prompt+response classification mode (`User Safety` for the instruction, `Response Safety`
for the AI's action) that maps cleanly onto "instruction vs. tool call." Rebuilt the
`nvidia-content-safety` prompt around this: canonical delimited taxonomy, the documented
custom categories, the two-turn conversation framing, and fixed the parser to prefer
`Response Safety` over `User Safety`. Result: no better, and on one scenario slightly
worse (a case that previously denied correctly started returning only a `User Safety`
line with nothing judging the actual action). Applying the "correct" documented pattern
is still worth doing, it's the honest way to use these models, and may serve better
against other members of the family, but for this specific quantized model, it did not
rescue the underlying task/domain mismatch from #4.

### 6. What actually matters: false approvals, not raw accuracy

Overall "% correct" is the wrong headline metric. A **deny** verdict still reaches the
human (they can override it); an **approve** verdict skips them entirely. The only
failure mode with real safety cost is a false approve. Recomputing every comparison on
that basis: the fixed classifier had a 40 to 60% false-approve rate on any scenario
requiring instruction/action matching (an out-of-scope deletion, a credential read with a
plausible-sounding but unrelated task), reliably denying only the context-free,
unambiguous cases.

### 7. A real instruction-following model actually does the reasoning

Tested a 35B general model (Qwen, "uncensored" fine-tune) with `chat-judge`. It produced
genuinely correct, legible reasoning, e.g. correctly identifying "the instruction asks
to write a haiku, but the tool deletes an unrelated file" as a scope mismatch, something
the classifier could never do. This confirmed the `chat-judge` design itself was sound;
the earlier failures were about model choice, not prompt design. Downside: verbose
chain-of-thought reasoning frequently exceeded even a generous token cap, and it's a slow,
heavy model to run as a gate on every tool call.

### 8. The practical winner: a small model, correctly paired

Tested Gemma 3 4B, small, fast, cheap enough to run as an always-on gate, with
`chat-judge`. Result: zero false approves across 88 deterministic trials (11
scenarios x 8 repeats, every pair unanimous). Its only misses were false denies: it
treats "delete" and "force-push" as near-absolute red flags even when the instruction
explicitly names that exact target as legitimate. That bias survived an explicit,
targeted counter-instruction in the prompt ("do not deny just because the action sounds
severe") with zero measurable effect, the same "prompt wording doesn't move this"
result as with the classifier, but this time on a model that demonstrably can reason
about everything else. Read as a property of the model's own safety fine-tuning, not a
fixable prompt gap.

That failure direction, occasionally over-cautious, never silently permissive, is
the correct one for a safety gate, so it was left as-is rather than chased further.
Chasing a clean sweep on an 11-scenario hand-built set would have been overfitting to the
test, not a real reliability gain.

## Recommendation

Prefer `chat-judge` with a genuine instruction-following model, even a small, fast one,
over a dedicated content-safety classifier, unless the classifier is only ever guarding
context-free, categorical cases (in which case `nvidia-content-safety` is a reasonable
coarse first-pass filter). Always pin `temperature: 0`. Always test with repeated trials
before trusting a single comparison. Judge reliability by false-approve rate, not raw
accuracy.

## Reproducing this

`packages/engine/scripts/live-safety-test.ts`: a throwaway (not part of the test suite)
harness that runs a fixed scenario matrix against a real OpenAI-compatible model server,
multiple trials each, and reports per-scenario consistency plus a false-approve breakdown.

```
MARSHALL_SAFETY_HOST=http://host:port \
MARSHALL_SAFETY_MODEL="model-id" \
MARSHALL_SAFETY_TRIALS=8 \
MARSHALL_SAFETY_MAX_TOKENS=1200 \
MARSHALL_SAFETY_KINDS=chat-judge \
node --import tsx/esm packages/engine/scripts/live-safety-test.ts
```

The automated test suite (`packages/engine/src/safety-agent.test.ts`,
`packages/engine/src/integration/safety-agent-level3.test.ts`) covers the mechanical
pieces, parsing, prompt construction, decider wiring, history isolation, against a fake
HTTP server, deterministically. It does not and cannot cover model judgment quality;
that's what the live-test script is for, against a model you actually intend to deploy.
