import type { AgentProfile, EngineConfig } from '@agentionai/marshall-engine';
import { DEFAULT_COMMAND_POLICY } from '@agentionai/marshall-tools';
import { PROMPT_CANDIDATES } from './prompt-candidates.js';

/**
 * One row in the benchmark matrix: a main agent profile, plus an optional
 * separate profile for the `context` tool (fast reader/summarizer). Nothing
 * here is specific to any one provider or model — swap in whatever your
 * llamacpp/ollama/claude/etc. setup exposes.
 */
export interface BenchConfiguration {
  /** Short label used in the results table. */
  name: string;
  /** Keep every tool result verbatim and drop `retrieve_tool_result`. */
  noMasking?: boolean;
  /** Offer only these tools, whatever else the belt would have carried. */
  toolAllowlist?: string[];
  /** Render `read_file` output with a `12 | ` gutter (the pre-2026-08-26 default). */
  readLineNumbers?: boolean;
  /** Replace the coder's system prompt outright. */
  systemPromptOverride?: string;
  agent: AgentProfile;
  contextAgent?: AgentProfile;
  plannerAgent?: AgentProfile;
  reviewerAgent?: AgentProfile;
  /** Runs with the trimmed tool-schema belt — see `EngineConfig.light`. */
  light?: boolean;
}

const LLAMACPP_HOST = process.env.MARSHALL_BENCH_HOST ?? 'http://127.0.0.1:8080';

/** Local llamacpp models currently available on the router, by role. */
export const MODELS = {
  smart: 'Qwen3.6-27B-Uncensored-HauhauCS-Balanced-MTP-Q6_K_P',
  fast: 'Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive-Q6_K_P',
  ornith: 'ornith-ai/Ornith-1.5-35B-A3B-GGUF:Q4_K_M',
  tiel: 'peculiar-ragdoll/Tiel-Coder-35B-A3B-GGUF-MTP:Q4_K_XL',
  // Reasoning level is baked into this alias at launch, not per-request:
  // the server preset carries `--chat-template-kwargs
  // '{"reasoning_effort":"medium"}'`. There is no equivalent lever on this
  // model from a client — swap presets server-side for a different level.
  qwen38: 'unsloth/Qwen3.8-27B-GGUF:Q4_K_XL',
  // The FP4-imat build rather than unsloth's IQ4_XS: it is the only
  // Flash-Next preset carrying an explicit `ctx-size` (131072). The router
  // gives every model 4 parallel slots against one unified KV cache, so a
  // preset with no ctx-size runs a long agentic task into the context
  // exhaustion diagnosed on 2026-08-27 rather than measuring anything.
  qwen38flash: 'qwen4exp/Qwen3.8-Flash-Next-ROCmFP4-FAST-imat',
} as const;

/**
 * The model the long-run instrumentation targets.
 *
 * Pinned to one exact id on purpose: the router keeps several Ornith quants
 * loaded at once, each in its own child llama-server on its own port, and
 * bench/llama-journal.ts filters the journal by that port. Two quants would be
 * indistinguishable in the results and their numbers would silently merge.
 */
export const INSTRUMENTED_MODEL: string = MODELS.ornith;

function llamacpp(model: string): AgentProfile {
  return { provider: 'llamacpp', model, host: LLAMACPP_HOST };
}

// hybrid plus an explicit line about search's patterns[]/list_dir's paths[] —
// hybrid's systemPromptOverride bypasses FILE_RULES entirely (see
// agent-factory.ts), so the batching guideline added there never reaches a
// row using this. See the luna-hybrid-batch-prompt row below for what this
// is testing and what was found without it.
const HYBRID_BATCH_PROMPT =
  'You are an expert coding assistant. You help users by reading files, executing commands, ' +
  'editing code, and writing new files.\n\n' +
  'Guidelines:\n' +
  '- Use read_file to examine files instead of cat or sed.\n' +
  '- Batch unrelated searches into one search call via patterns[], and unrelated directory ' +
  'listings into one list_dir call via paths[], instead of issuing them one at a time.\n' +
  '- Use edit_file for precise changes (edits[].oldString must match exactly)\n' +
  '- When changing multiple separate locations in one file, use one edit_file call with ' +
  'multiple entries in edits[] instead of multiple edit_file calls\n' +
  '- Each edits[].oldString is matched against the original file, not after earlier edits are ' +
  'applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.\n' +
  '- Keep edits[].oldString as small as possible while still being unique in the file. Do not ' +
  'pad with large unchanged regions.\n' +
  '- Use write_file only for new files or complete rewrites.\n' +
  '- Show file paths clearly when working with files\n' +
  '- When done, give a single short sentence describing what changed';

/**
 * The configurations to benchmark. Edit this list to add/remove models or
 * providers — the harness itself has no model names in it.
 */
export const CONFIGURATIONS: BenchConfiguration[] = [
  // Solo on purpose. Sub-agents would run on this same model, so their
  // requests would be indistinguishable from the coder's both in the journal
  // (same child port) and on the wire, and the peak-context figure would be
  // attributed to whichever request happened to be largest.
  { name: 'ornith-solo', agent: llamacpp(MODELS.ornith) },
  // The same model and task with the belt trimmed to what `pi` actually
  // carries — no scratchpad, no background jobs, no sub-agents — which is the
  // closest the two harnesses get to a like-for-like tool surface.
  { name: 'ornith-solo-light', agent: llamacpp(MODELS.ornith), light: true },
  // Masking keeps only the last few tool results verbatim, which on a task that
  // reads many files and then edits them removes exactly the content the model
  // is about to need. This row keeps them all, and drops the retrieval tool
  // that exists to undo the masking.
  { name: 'ornith-solo-nomask', agent: llamacpp(MODELS.ornith), noMasking: true },
  // A second model on the same router. Every harness-level explanation for the
  // thinking gap has been eliminated, which leaves the possibility that it is a
  // property of Ornith rather than of marshall. Running both harnesses against
  // a different model is what separates those two.
  { name: 'tiel-solo', agent: llamacpp(MODELS.tiel) },
  { name: 'qwen38-solo', agent: llamacpp(MODELS.qwen38) },
  // The floor of the tool-surface experiment: one tool, and the model does
  // everything through the shell. Tool count is the only lever measurably
  // driving reasoning volume (17 -> 7 tools cut thinking per request 23%), so
  // this is where that line ends. It gives up the read gate and the per-edit
  // approval diff, which is why it is a measurement and not a proposal.
  { name: 'ornith-shell-only', agent: llamacpp(MODELS.ornith), toolAllowlist: ['run_shell'] },
  // The control for the gutter change. `ornith-solo` now reads raw, so this row
  // is the old behaviour held otherwise identical — the only way to say whether
  // removing the gutter did anything is to run both.
  { name: 'ornith-gutter', agent: llamacpp(MODELS.ornith), readLineNumbers: true },
  // pi's own system prompt, captured verbatim off the wire (bug-fix, 2026-08-26),
  // minus its tool-name list (pi's tool names, not ours) and its pi-specific
  // docs section (irrelevant to this task). Everything else — the framing,
  // guidelines, "be concise" — is pi's actual words. If the front-loaded
  // planning burst survives this, the prompt text is not the cause.
  // Bare minimum: no rules at all, just the header. Tests whether ANY prompt
  // guidance is what invites the careful/systematic mode, independent of what
  // the guidance actually says.
  {
    name: 'ornith-bare-prompt',
    agent: llamacpp(MODELS.ornith),
    systemPromptOverride: 'You are a coding assistant. Be terse and direct.',
  },
  // Our current rules, plus one explicit instruction targeting the observed
  // behaviour directly: reading the model's own reasoning traces on this task
  // showed it stopping, after reading every file, to derive the complete
  // transformation for all remaining files in one uninterrupted pass before
  // touching a tool — 7000+ tokens in one call, unprompted by anything else
  // in the prompt. This tells it not to.
  {
    name: 'ornith-incremental-prompt',
    agent: llamacpp(MODELS.ornith),
    systemPromptOverride:
      'You are Marshall, a coding assistant. Be terse and direct — no filler, no emojis, no padding.\n\n' +
      'Rules:\n' +
      '- Always read_file before writing or editing an existing file. Once per file is enough.\n' +
      '- Use edit_file for targeted changes, write_file only for new files or full rewrites.\n' +
      '- Batch every change you have decided on for one file into a single edit_file call, one entry per change in edits[].\n' +
      '- Work incrementally on a task touching many similar files: read one, decide its edits, apply ' +
      'them, move to the next. Do not read every file first and work out the complete plan for all of ' +
      'them before making any change — start applying edits as soon as you understand the pattern from ' +
      'the first few files, and let later files confirm or adjust it.\n' +
      '- When done, give a single short sentence describing what changed.',
  },
  {
    name: 'ornith-hybrid-prompt',
    agent: llamacpp(MODELS.ornith),
    // pi's structure/brevity (see PROMPT_CANDIDATES's doc comment — this is
    // what shrank the long-task planning burst) plus marshall-current's exact
    // closing-sentence rule (what won the short-task quality ranking against
    // pi-adapted's softer "be concise"). Imported rather than inlined so this
    // row and prompt-eval.ts's quality ranking can never disagree about what
    // "hybrid" means.
    systemPromptOverride: PROMPT_CANDIDATES.hybrid,
  },
  {
    name: 'ornith-pi-prompt',
    agent: llamacpp(MODELS.ornith),
    // pi's own system prompt, captured verbatim off the wire (bug-fix,
    // 2026-08-26), left otherwise unmodified — including its own tool names
    // (read/edit/write/bash), which do not match ours (read_file/edit_file/
    // write_file/run_shell). The model still calls tools by the names in the
    // API's `tools` schema, which are ours regardless of what the prose says,
    // so this mismatch tests whether pi's exact phrasing still suppresses the
    // front-loaded planning burst even when the prose doesn't line up with
    // the real tool names. Dropped only: the Pi-product documentation block
    // (its own README/SDK/extensions paths — config metadata, not prompt
    // content) and the two dynamically-injected "Current date"/"Current
    // working directory" lines, which would be stale and misleading here
    // rather than meaningfully part of "the prompt".
    systemPromptOverride:
      'You are an expert coding assistant operating inside pi, a coding agent harness. ' +
      'You help users by reading files, executing commands, editing code, and writing new files.\n\n' +
      'Available tools:\n' +
      '- read: Read file contents\n' +
      '- bash: Execute bash commands (ls, grep, find, etc.)\n' +
      '- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call\n' +
      '- write: Create or overwrite files\n\n' +
      'In addition to the tools above, you may have access to other custom tools depending on the project.\n\n' +
      'Guidelines:\n' +
      '- Use bash for file operations like ls, rg, find\n' +
      '- Use read to examine files instead of cat or sed.\n' +
      '- Use edit for precise changes (edits[].oldText must match exactly)\n' +
      '- When changing multiple separate locations in one file, use one edit call with ' +
      'multiple entries in edits[] instead of multiple edit calls\n' +
      '- Each edits[].oldText is matched against the original file, not after earlier edits are ' +
      'applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.\n' +
      '- Keep edits[].oldText as small as possible while still being unique in the file. Do not ' +
      'pad with large unchanged regions.\n' +
      '- Use write only for new files or complete rewrites.\n' +
      '- Be concise in your responses\n' +
      '- Show file paths clearly when working with files',
  },
  { name: 'smart-solo', agent: llamacpp(MODELS.smart) },
  { name: 'fast-solo', agent: llamacpp(MODELS.fast) },
  { name: 'smart-main+fast-context', agent: llamacpp(MODELS.smart), contextAgent: llamacpp(MODELS.fast) },
  {
    name: 'fast-main+smart-planner+reviewer',
    agent: llamacpp(MODELS.fast),
    plannerAgent: llamacpp(MODELS.smart),
    reviewerAgent: llamacpp(MODELS.smart),
  },
  // Same model as EXTERNAL_HARNESSES's pi/opencode rows, on purpose — this is
  // the one marshall row a `pi`/`opencode` comparison is actually fair
  // against. Needs OPENROUTER_API_KEY; no apiKey field, so resolveAuth reads
  // it from the environment the same way the external harnesses do.
  { name: 'sonnet5-openrouter', agent: { provider: 'openrouter', model: 'anthropic/claude-sonnet-5' } },
  // Same model/task, tool-schema belt trimmed — isolates how much of the
  // input-token gap against pi/opencode is tool-schema overhead versus
  // conversation/read verbosity.
  { name: 'sonnet5-openrouter-light', agent: { provider: 'openrouter', model: 'anthropic/claude-sonnet-5' }, light: true },
  // Frontier-model data point: every finding so far (the output-token gap,
  // the edits[] batching win, the prompt-quality disagreement) was measured
  // only on local quants. Needs OPENROUTER_API_KEY, same as the sonnet5 rows.
  { name: 'luna-openrouter', agent: { provider: 'openrouter', model: 'openai/gpt-5.6-luna' } },
  { name: 'luna-openrouter-light', agent: { provider: 'openrouter', model: 'openai/gpt-5.6-luna' }, light: true },
  // On multi-file-migration (free-form), luna-openrouter read all ~28 source
  // files before writing its rewrite script, where pi-luna read only 5-6 and
  // generalized — 3x the tool calls, 2.3x the input tokens, for the same
  // passing result (see bench/runs/2026-08-28T10-25-44-702Z). incremental's
  // "don't read everything before acting" rule was written for per-file edit
  // sequences on the local models, but targets the same over-reading pattern.
  {
    name: 'luna-incremental-prompt',
    agent: { provider: 'openrouter', model: 'openai/gpt-5.6-luna' },
    systemPromptOverride: PROMPT_CANDIDATES.incremental,
  },
  // incremental measurably backfired on this task: it made Luna abandon the
  // read-a-sample/write-a-script strategy for a 45-call edit_file loop
  // (91 tool calls, 455,372 input tokens vs the default prompt's 48/152,129).
  // hybrid keeps pi's structure/brevity — the thing that suppressed the
  // original long-task planning burst on Ornith — without incremental's
  // per-file-edit push, and per prompt-candidates.ts was never measured on
  // the long task by either local or Luna runs before now.
  {
    name: 'luna-hybrid-prompt',
    agent: { provider: 'openrouter', model: 'openai/gpt-5.6-luna' },
    systemPromptOverride: PROMPT_CANDIDATES.hybrid,
  },
  // hybrid already came within 2 tool calls of pi (18 vs 16) and beat it on
  // cost. light trims the tool-schema belt down to what pi actually carries —
  // a separate lever from prompt wording — stacked here to see if it closes
  // the remaining gap.
  {
    name: 'luna-hybrid-prompt-light',
    agent: { provider: 'openrouter', model: 'openai/gpt-5.6-luna' },
    systemPromptOverride: PROMPT_CANDIDATES.hybrid,
    light: true,
  },
  // pi-luna's own transcript (bench/runs/2026-08-28T10-25-44-702Z) shows the
  // remaining gap isn't file-reading discipline — hybrid already matches that
  // — it's that pi runs exploration/verification through one `bash` call,
  // chaining find/rg/test/git with && where marshall's model calls the
  // dedicated list_dir/search tools once per step (search has no patterns[]
  // to batch, unlike edit_file's edits[]). One-off guideline on top of
  // hybrid, not yet promoted into prompt-candidates.ts — this is a single
  // experiment, not a vetted quality-ranked candidate.
  {
    name: 'luna-hybrid-shell-prompt',
    agent: { provider: 'openrouter', model: 'openai/gpt-5.6-luna' },
    systemPromptOverride:
      'You are an expert coding assistant. You help users by reading files, executing commands, ' +
      'editing code, and writing new files.\n\n' +
      'Guidelines:\n' +
      '- Use read_file to examine files instead of cat or sed.\n' +
      '- When exploring or verifying across many files (listing directories, searching several ' +
      'patterns, checking results), chain the commands with && in one run_shell call instead of ' +
      'issuing a separate list_dir/search call for each step.\n' +
      '- Use edit_file for precise changes (edits[].oldString must match exactly)\n' +
      '- When changing multiple separate locations in one file, use one edit_file call with ' +
      'multiple entries in edits[] instead of multiple edit_file calls\n' +
      '- Each edits[].oldString is matched against the original file, not after earlier edits are ' +
      'applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.\n' +
      '- Keep edits[].oldString as small as possible while still being unique in the file. Do not ' +
      'pad with large unchanged regions.\n' +
      '- Use write_file only for new files or complete rewrites.\n' +
      '- Show file paths clearly when working with files\n' +
      '- When done, give a single short sentence describing what changed',
  },
  // shell-chaining (above) tried to get consolidation through prose alone and
  // didn't work — the model kept calling list_dir/search one-at-a-time even
  // when told to prefer run_shell chaining. search/list_dir now actually have
  // a batch form (patterns[]/paths[], mirroring edit_file's edits[] —
  // packages/tools/src/factories/file/search.ts, list-dir.ts), which the
  // hybrid-prompt rerun already showed the model uses from the tool
  // description alone, no prompt change needed (2026-08-28T12-17-10-381Z:
  // every search/list_dir call in that run batched 2-3 items). That run's
  // total still rose (18->21) because read_file jumped 6->12, unrelated to
  // batching and consistent with the ~5x single-trial variance flagged
  // earlier — this row adds the batching guideline directly into the prompt
  // (hybrid's systemPromptOverride bypasses FILE_RULES entirely, so the
  // guidance added there never reaches a systemPromptOverride row) to see if
  // stating it explicitly, on top of what the tool description already
  // achieves, changes anything, and multiple trials are what settle the
  // read_file noise question.
  {
    name: 'luna-hybrid-batch-prompt',
    agent: { provider: 'openrouter', model: 'openai/gpt-5.6-luna' },
    systemPromptOverride: HYBRID_BATCH_PROMPT,
  },
  // light was only ever tried against plain hybrid, before search/list_dir
  // had a batch form to trim tool-schema overhead alongside. Untested
  // combination now that both levers exist.
  {
    name: 'luna-hybrid-batch-prompt-light',
    agent: { provider: 'openrouter', model: 'openai/gpt-5.6-luna' },
    systemPromptOverride: HYBRID_BATCH_PROMPT,
    light: true,
  },
  // A second frontier model, to separate "the batching work helps" from "the
  // batching work helps Luna". No systemPromptOverride on the first row on
  // purpose: FILE_RULES now carries the batching guidance itself, so this is
  // the shipped default rather than a bench-only prompt, and the honest
  // subject of a "does the release beat pi" comparison.
  { name: 'glm-openrouter', agent: { provider: 'openrouter', model: 'z-ai/glm-5.3-flash' } },
  {
    name: 'glm-hybrid-batch-prompt',
    agent: { provider: 'openrouter', model: 'z-ai/glm-5.3-flash' },
    systemPromptOverride: HYBRID_BATCH_PROMPT,
  },
  {
    name: 'glm-hybrid-batch-prompt-light',
    agent: { provider: 'openrouter', model: 'z-ai/glm-5.3-flash' },
    systemPromptOverride: HYBRID_BATCH_PROMPT,
    light: true,
  },
  // pi's own wording, unmodified apart from tool names — the thing that has
  // actually beaten us on every model tested (Ornith, Luna, GLM), and which
  // had never been run on the long task for anything but Ornith. `hybrid`
  // differs from it by exactly one line: pi's "Be concise in your responses"
  // swapped for marshall's "single short sentence" closing rule. That swap is
  // already recorded in prompt-candidates.ts as having broken the efficiency
  // win on Ornith, and hybrid then went on to lose badly on GLM (37 calls,
  // 1/2 passing, against pi's 7.0 and 2/2). This row asks the question that
  // implies: is pi's advantage the prompt itself rather than anything
  // structural about its harness?
  {
    name: 'glm-pi-adapted-prompt',
    agent: { provider: 'openrouter', model: 'z-ai/glm-5.3-flash' },
    systemPromptOverride: PROMPT_CANDIDATES['pi-adapted'],
  },
  // Tool count as the lever, now that the model demonstrably will work through
  // the shell (2026-08-30T11-46-29-314Z: read_file fell to 1-2 calls a run once
  // the description pointed at run_shell). read_file/list_dir/search are all
  // expressible as shell commands, so offering them is offering a second way to
  // do what bash already does — and the earlier Ornith sweep measured tool count
  // as the one lever that moved reasoning volume (17 -> 7 tools cut thinking per
  // request 23%).
  //
  // edit_file and write_file stay: they are the mutations, and they are what
  // renders a reviewable diff at the approval gate. `sed -i` through run_shell
  // is the same edit with nothing to show a reviewer, so dropping them trades
  // away the safety surface rather than any tokens worth having.
  {
    name: 'glm-shell-edit',
    agent: { provider: 'openrouter', model: 'z-ai/glm-5.3-flash' },
    toolAllowlist: ['run_shell', 'edit_file', 'write_file'],
  },
  // The floor, for comparison only: one tool, every mutation unreviewable.
  // Not a shippable shape — it gives up the approval diff entirely — and
  // measured as such: 7.0 calls, matching pi exactly, while failing the task
  // outright on one of two trials (115 of 122 tests still red, the migration
  // simply not done). Call count is not the thing worth optimising.
  {
    name: 'glm-shell-only',
    agent: { provider: 'openrouter', model: 'z-ai/glm-5.3-flash' },
    toolAllowlist: ['run_shell'],
  },
  // The same reduced belt on the other frontier model, because every prompt
  // finding this session has been model-specific and there is no reason to
  // assume a belt finding is not. glm-shell-edit went 37 -> 10 calls at 2/2;
  // whether that is a property of the belt or of GLM is what this answers.
  {
    name: 'luna-shell-edit',
    agent: { provider: 'openrouter', model: 'openai/gpt-5.6-luna' },
    toolAllowlist: ['run_shell', 'edit_file', 'write_file'],
  },
  // The belt finding held on both frontier models (Luna 18.7 -> 5.0 calls,
  // GLM 37 -> 10). A local quant is the harder case and the one that matters
  // for whether this becomes the default: it has to drive the shell itself,
  // and every prompt finding this session has failed to transfer down to
  // smaller models at least once.
  { name: 'qwen38flash-solo', agent: llamacpp(MODELS.qwen38flash) },
  {
    name: 'qwen38flash-shell-edit',
    agent: llamacpp(MODELS.qwen38flash),
    toolAllowlist: ['run_shell', 'edit_file', 'write_file'],
  },
  // The hosted build of the same family, used because the local router went
  // down mid-setup. Not interchangeable with the llamacpp rows above: a
  // different quant, different sampler, and no journal instrumentation — so
  // these answer "does the belt finding hold on a third model", not "how does
  // the local quant behave".
  { name: 'qwen38flash-or-solo', agent: { provider: 'openrouter', model: 'qwen/qwen3.8-flash' } },
  {
    name: 'qwen38flash-or-shell-edit',
    agent: { provider: 'openrouter', model: 'qwen/qwen3.8-flash' },
    toolAllowlist: ['run_shell', 'edit_file', 'write_file'],
  },
];

/**
 * `pi` / `opencode` rows, run via their real CLIs — see external-harness.ts.
 * Opt-in only: unlike `CONFIGURATIONS`, these never run unless named
 * explicitly with `--config`, since they need OPENROUTER_API_KEY and the
 * actual CLIs installed, and shell out to a real, billed API on every call.
 *
 * Same task set, same fixtures, same `check()` verifiers as the marshall
 * rows — that's what makes a row here comparable to one of those, not just
 * adjacent to it.
 */
export const EXTERNAL_HARNESSES: import('./external-harness.js').ExternalHarnessConfig[] = [
  // The row that is actually comparable to `ornith-solo`: same model, same
  // llama.cpp router, and therefore measured by the same llama-server slot logs
  // rather than by each CLI's own self-reporting. Needs no API key.
  {
    name: 'pi-ornith',
    harness: 'pi',
    model: MODELS.ornith,
    provider: 'llama-cpp',
    configDir: new URL('./pi-config/', import.meta.url).pathname,
  },
  {
    name: 'pi-tiel',
    harness: 'pi',
    model: MODELS.tiel,
    provider: 'llama-cpp',
    configDir: new URL('./pi-config/', import.meta.url).pathname,
  },
  { name: 'pi', harness: 'pi', model: 'anthropic/claude-sonnet-5' },
  { name: 'opencode', harness: 'opencode', model: 'anthropic/claude-sonnet-5' },
  { name: 'pi-luna', harness: 'pi', model: 'openai/gpt-5.6-luna' },
  { name: 'pi-glm', harness: 'pi', model: 'z-ai/glm-5.3-flash' },
];

export const BENCH_ENGINE_DEFAULTS: Partial<EngineConfig> = {
  enableGitHub: false,
  enableWebSearch: false,
  // Raised from 8192 for the multi-file tasks: a run that rewrites several
  // call sites in one response hits the old ceiling and gets truncated
  // mid-edit, which shows up as a task failure that is really a config limit.
  maxTokens: 16384,
  commandPolicy: DEFAULT_COMMAND_POLICY,
};

/**
 * Per-task wall-clock budget before the harness gives up and marks it a timeout.
 *
 * 20 minutes, not the 5 it used to be: the long file-migration task runs 40+
 * tool calls against a local model at ~50 tok/s, and the old budget cut it off
 * partway through every time — recording a config limit as a model failure.
 * Override per run with `--timeout <seconds>`.
 */
export const TASK_TIMEOUT_MS = 20 * 60 * 1000;
