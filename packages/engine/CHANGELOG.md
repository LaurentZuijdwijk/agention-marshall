# @agentionai/marshall-engine

## 0.25.1

### Patch Changes

- Automatically select a free loopback port when a managed plugin's preferred port is occupied, remembering the selected port globally for subsequent launches. Browser server reuse now requires a matching health identifier so legacy or unrelated listeners are left alone. Status, setup probes, downloads, and extension pairing instructions use the selected port; after a port change, update the extension popup's Advanced bridge URL and save to reconnect.

## 0.25.0

### Minor Changes

- Add a `codex` provider: OpenAI models reached through a ChatGPT subscription rather than a platform API key, built on `CodexAgent` from `@agentionai/agents` 1.13. It serves its own model namespace (`gpt-5.6-luna`, `gpt-5.6-sol`, …), listed live from the account's plan, and defaults to `gpt-5.6-luna`. The `openai` provider is unchanged and remains the platform-key path.

  Add `/login codex` to sign in with ChatGPT. It adopts an existing `codex login` when there is one, and otherwise runs the PKCE flow in a browser, capturing the authorization code on a loopback callback listener rather than asking for a paste. The access token is refreshed as it ages out and the rotated refresh token written back, so a session outlives its hour-long token.

  Store OAuth logins per provider, so signing in to one account no longer signs out the other. The previous single-login file is still read, and the setup wizard stops asking for an API key for a provider that is already signed in.

  Fix the `openai` model shortlist, which listed `gpt-5.6-luna` and its siblings — Codex-only models that the platform API rejects outright. Those now appear under `codex`, and `openai` offers platform ids.

### Patch Changes

- Keep approval and image-recovery selections from also submitting or changing the query draft. Preserve endpoint identity when resolving fast-tier credentials, prevent project host overrides from redirecting global or ambient credentials, and report failed configuration saves accurately while refreshing partially saved state.

  Cancel SDK execution and delegated calls when a turn is interrupted, preventing abandoned work from issuing requests or altering subsequent history. Preserve external file changes across targeted edits by invalidating stale full-read coverage, and reject scratch paths containing symlinks before ungated filesystem access.

- Updated dependencies
  - @agentionai/marshall-tools@0.9.3

## 0.24.2

### Patch Changes

- b41d7c5: Reports from agents and background jobs that finish mid-turn are no longer lost to the model
  that asks for them.

  A finished agent's report, like a finished job's output, is queued and delivered at the front of
  the next turn — the only point where injecting it is safe. But the queue drained the report out
  of the registry at enqueue time, so a parent still working when its agent finished found
  `agent_output` answering "its report has already been delivered to you" about words that were
  sitting in the queue, and `shell_output` answering "no new output" for a command whose output was
  exactly what it had gone to read. Observed live: a parent that could not read any of its eleven
  agents' reports during a ten-minute turn, and re-ran its test command with output redirected to
  files to get around it.

  The queue now renders each report when it is delivered. Whichever reader comes first — the model
  asking, or the wake-up at the next turn — gets the body. An agent report the model already read
  is then spent: it neither wakes the parent nor appears at the front of its next turn, since the
  parent saw the status when it took the report and an unattended turn with nothing to say is pure
  cost. Failed and timed-out agents, and finished jobs, still report — nothing drains those, so
  nothing says they were seen. `agent_output`'s description says so. Running agents also now report
  when their last tool call returned, since elapsed time alone cannot tell thinking from wedged.

- Updated dependencies [b41d7c5]
  - @agentionai/marshall-tools@0.9.2

## 0.24.1

### Patch Changes

- 7ddc34a: Update `@agentionai/agents` to 1.12.0.

  The release is additive, so no behaviour changes with it yet. It brings two things worth knowing
  about. Streaming agents now hand back what a turn had generated when it was cut short, on
  `BaseAgent.lastPartialTurn`, on `AgentError.partial`, and as a new `AgentEvent.PARTIAL_TURN`: the
  text, the reasoning trail, and any tool calls that had started to arrive, along with why it stopped
  (`error`, `aborted`, `max_tokens`, or `abandoned`). It is deliberately never written to history,
  since truncated tool-call JSON does not parse and an Anthropic thinking block needs the signature
  that arrives last, so recovering it stays the caller's decision.

  The other addition is a `reasoning-text` module exporting `collapseReasoningWhitespace()`, which
  tidies the heavily bulleted chain-of-thought that GLM-series models and some OpenRouter routes
  stream. It is display-only: the stored string has to go back to the provider byte for byte.

- Updated dependencies [7ddc34a]
  - @agentionai/marshall-tools@0.9.1

## 0.24.0

### Minor Changes

- Add browser control and screenshots for the coding agent, via a new local MCP server (`@agentionai/marshall-plugin-browser`) backed by a companion Chrome extension (`packages/browser-extension`, unpublished). Screenshots reach the model as real vision input: MCP tool results can now carry image content that lands in front of the model on the next turn, via a new `ToolConfig.attachImages` — any MCP server returning image content benefits, not just this one. `browser_read_page` supports a token-cheap `text` mode (default) and a full `html` mode. The extension shows a small on-page indicator while Marshall is driving a tab, hidden automatically during a screenshot.

  Also adds a minimal, real slice of the plugin system: a `plugins` config array and a `/plugins add|disable|list` command that spawns a locally-managed plugin's server, health-checks it, and auto-registers it as an MCP server — no more hand-editing `mcpServers` or re-pasting a pairing token every session. `/plugins add browser` is the first consumer.

### Patch Changes

- Split line-addressed replacement out of `edit_file` into its own `edit_lines` tool. `edit_file` now only accepts `oldString`/`newString`, with a fully-specified schema (`required` on both fields — previously impossible, since one `edits[]` entry had to validate against two different shapes). `edit_lines` takes `startLine`/`endLine`/`newString` and keeps the same read-before-line-edit safety gate `edit_file` used to enforce for that case, plus a bare top-level fallback symmetric with `edit_file`'s (a call with `startLine`/`endLine` and no `edits` wrapper now works, instead of failing with an unexplained "no edits given").
- Updated dependencies
- Updated dependencies
  - @agentionai/marshall-tools@0.9.0

## 0.23.0

### Minor Changes

- 81d7345: Tell the model to batch its file calls, and log what a turn actually cost.

  The coder's `FILE_RULES` and a spawned agent's rules now both say to put every change to one file
  in a single `edit_file` call, to keep each `oldString` only as long as uniqueness needs, and to
  batch unrelated searches and directory listings through `patterns[]`/`paths[]`. The guidance lives
  in the same two places, so a sub-agent is told what the coder is told.

  They also now say to take in several files with one `run_shell` call
  (`grep -rl PATTERN src | xargs cat`) rather than one `read_file` each, and that `read_file` is for
  understanding code rather than for unlocking an edit — `edit_file` no longer requires a prior read
  (see `@agentionai/marshall-tools`). Measured on a 28-file migration against `z-ai/glm-5.3-flash`,
  those two changes together took a run from 37 tool calls and one timeout in two attempts, to 14
  calls and two of two passing. The same wording is in `read_file`'s own description, so the prompt
  and the schema cannot drift apart.

  Two things a run's cost is made of were invisible in the session log. Tool failures are one: every
  tool in the belt reports failure by _returning_ a string rather than throwing, so a refused edit —
  an `oldString` matching nothing, a write blocked because the file changed — left no trace once the
  turn ended, while the model paid to re-emit the whole edit body on the retry. Those now log as
  `TOOL_FAIL`. Assistant narration between tool calls is the other, and the largest single component
  of output tokens; its length now logs as `ASSISTANT_TEXT`. `TOOL_CALL` carries the full argument
  length alongside its truncated preview, since a 200-character preview cannot measure a batched
  edit payload running to thousands.

  Adds `maskToolResults` (default unchanged) to keep every tool result verbatim and drop
  `retrieve_tool_result` from the belt. Masking keeps a long conversation small at the cost of the
  model no longer seeing what a tool returned more than `maskingKeepRecent` results ago — which, on
  a task that reads many files and then edits them, is exactly the content it is about to need.

  Two consequences worth stating plainly. Dropping the read requirement on `edit_file` trades a
  guardrail for a round trip per file: the `oldString` argument makes a _misplaced_ edit fail loudly,
  but it says nothing about whether an edit is sensible in content the model never read, and the
  compensating control — the diff at the approval gate — is not there under auto-approve. And the
  CLI now runs with `NODE_ENV=production` when nothing else set it, so anyone working on the TUI
  loses react-reconciler's development warnings unless they export `NODE_ENV=development`
  themselves; that value is deliberately not forwarded to the commands the agent runs.

### Patch Changes

- Updated dependencies [81d7345]
  - @agentionai/marshall-tools@0.8.0

## 0.22.0

### Minor Changes

- Give a provider's rejection of an attached image its own recovery path instead of dying as a
  generic error. Attaching an image to a local model with no vision support loaded (no mmproj) used
  to surface as an opaque failure with nothing to do but retype the task — the image itself was
  never the thing at fault, so there was always a clean way forward, the UI just didn't offer one.

  `classifyProviderError` now takes whether the turn carried images and, when it did, checks the
  message against the two patterns providers actually use for this — llama.cpp's own wording
  ("mmproj", "failed to process mtmd chunk") and the more generic "image ... not supported" shape —
  ahead of the context-length fallback, since a model with no vision support answers with a bare 400
  that reads exactly like a context overflow otherwise. Compressing history would do nothing for it.

  The engine reports it as its own `image-rejected` event (message + the original task, already
  popped from history) rather than folding it into `error`. The CLI shows a panel with the two real
  options: remove the image and resend the same task (`stripImageLabels` strips the `[image #N]`
  placeholders so the model isn't told to look at something no longer attached), or switch to a
  vision-capable model first via the same wizard `/model` opens.

- Add `--private`: a session that writes nothing to disk beyond the workspace files you actually
  asked it to edit, and prefers a model that doesn't retain the prompt.

  No session log, no history/reasoning/http trace, no scratchpad notes (`note_*`/`log_*` drop out of
  the belt, same as `light` mode). `ConfigService` refuses every write for the session — no API key,
  model pick, MCP config or safety setting lands in `config.json` — leaving whatever was already on
  disk untouched. A crash still gets reported, to stderr instead of `.marshall/logs/session.log`, so
  the process doesn't die silently but nothing about it persists either.

  Every agent the session can spawn — the coder, sub-agents, the compression summariser, the safety
  judge — now threads a `privateMode` flag through `createAgent`. On OpenRouter this sets
  `provider: { dataCollection: 'deny' }`, restricting routing to upstreams that don't retain the
  prompt; llama.cpp and Ollama need no such flag, since nothing leaves the machine. Every other
  provider has no equivalent request-level option in this SDK, so the session posts a one-time
  warning naming whichever provider isn't enforced instead of pretending the guarantee is universal.

  Session-scoped by design: there is no `/private` command and nothing persists it to a settings
  file, so it can't quietly outlive the run it was asked for. The header shows `private on` while
  it's active.

### Patch Changes

- a25ad81: Fix a stale system message surviving a mid-session prompt change (`/runtime light`,
  `/runtime agentic`, or any change to which tools are available) and ending up no longer first in
  the request — several providers reject that outright (llama.cpp's Jinja chat template: "System
  message must be at the beginning").

  The SDK's own system-message guard only skips re-adding when the content is byte-identical to
  what's already there; otherwise it appends a second entry rather than replacing the first, since
  the underlying `History.addSystem` is a plain push. The session's History is shared and long-lived
  — a fresh agent is constructed every turn against the same object — so a prompt that legitimately
  differs from last turn's used to leave the old entry in place and land the new one wherever
  history currently ended, after real user/assistant turns.

  `Session` now keeps its own system entry first and current, using the exact content
  `createAgent`'s own call is about to ask for (`agentSystemMessage`/`buildAgentDescription`, both
  now exported from `agent-factory.ts` for this): a no-op when nothing changed, a clean
  replace-and-reposition when it did.

## 0.21.0

### Minor Changes

- 014ea7a: Retry a dropped connection mid-turn instead of ending it. A `'connection'`-classified provider
  error (`fetch failed`, `terminated`, `ECONNRESET`, ...) is not the provider saying no — the
  request was simply never answered — so it no longer goes straight to the client as a failure.
  History already holds everything the turn did up to the drop (tool calls, their results,
  reasoning), so the retry is a short "continue where you left off" nudge, not a resend of the
  original task. Bounded (`EngineConfig.maxConnectionRetries`, default 3) with exponential backoff
  plus jitter (`connectionRetryBaseMs`, default 2000ms, capped at 30s) — a genuinely dead endpoint
  still ends the turn and reports the error, just after giving it a real chance to recover first.

  Surfaced by a Terminal-Bench run where a long tool-calling turn (5+ hours, 330K input tokens of
  real progress) was thrown away entirely by one transient network blip.

  Also fixes `isConnectionError` not matching `terminated` — Node's `fetch` error for a socket the
  far end closed mid-response, and, on a very long turn, one of the more likely ways to see this at
  all.

### Patch Changes

- Rework the coder's system-prompt header: "You are an expert coding assistant operating inside
  Marshall, a coding agent harness." replaces "You are Marshall, a coding assistant. Be terse and
  direct — no filler, no emojis, no padding."

  Two changes. First, "Be terse and direct" is gone — plausible instinct is that it was pushing
  weaker/local models toward rushed, incomplete answers on multi-step tasks rather than genuinely
  concise ones; "no filler, no emojis, no padding" already covers unwanted padding without also
  capping how much verification or explanation a hard task needs. Second, "You are Marshall" (a
  branded persona) becomes "an expert coding assistant operating inside Marshall, a coding agent
  harness" — Marshall is what the model is _running inside_, not what it _is_. Modeled on how pi
  (`@earendil-works/pi-coding-agent`), the closest comparable open-source harness, frames the same
  thing: "You are an expert coding assistant operating inside pi, a coding agent harness." "Expert"
  carries over from that same comparison (also Aider's "Act as an expert software developer") on
  the theory that it measurably helps model confidence on coding tasks.

  Not yet benchmarked in isolation — see bench/harbor_agent/ for the Terminal-Bench harness this
  can be evaluated against.

## 0.20.2

### Patch Changes

- 7f710c9: Add `MARSHALL_TRACE_REASONING=1`, which appends each raw reasoning delta to
  `.marshall/logs/reasoning.log`, one JSON-encoded string per line.

  The session log records what you typed and which tools ran; neither it nor the history trace
  shows what a provider's reasoning stream actually looked like on the wire. That mattered when
  reasoning started rendering one word per row and the question was whether the line breaks came
  from the endpoint or from us — unanswerable from any existing log.

  JSON-encoded rather than written raw, because the whole question this answers is about
  whitespace, and a log that prints the text plainly hides exactly the thing being looked for.
  Off by default, read from the environment at call time like `MARSHALL_TRACE_HISTORY`, so turning
  it on is a restart and turning it off costs nothing.

## 0.20.1

### Patch Changes

- 1ddcb49: Stop compression from splitting a tool call away from its result, which made OpenAI, Azure and
  OpenRouter reject the next request with a bare 400 ("Missing tool call ID reference for function
  call outputs") that was then misreported as a full context window.

  The summary window is now aligned so a tool call and its result are kept together or summarised
  together, never half of each; a reduce that would still break a pairing is skipped rather than
  producing a history the provider rejects. The 400 itself is now recognised for what it is across
  the phrasings OpenAI, Azure and OpenRouter actually use, so it is reported instead of triggering a
  pointless compression pass. Sessions already carrying a broken pairing repair it before the next
  request rather than failing every turn from there on.

  Error classification is now one function (`classifyProviderError`) instead of the same condition
  duplicated at two call sites, and the session log names the rule that fired and whether it
  triggered compression (`kind=`, `because=`, `COMPRESSION_TRIGGERED_BY_ERROR`, `NO_COMPRESSION`).
  Content-filter rejections, invalid tool schemas and unsupported-parameter errors are now reported
  instead of spending a compression pass and being handed back as a full context window.

  Two repair details that the pairing work depends on: a cancelled tool call is now answered
  directly after the message that made it rather than at the end of history, so a break inherited
  from mid-conversation actually heals instead of producing a second rejection; and the repair no
  longer rebuilds history in a way that discards entry metadata, which had been erasing the marker
  that identifies a compression summary and causing an existing summary to be summarised again as
  if it were an ordinary turn.

- 1ddcb49: Session cost tracking now uses the actual USD OpenRouter billed for each call, when the
  provider reports it, instead of only a local price-table lookup.

  The price table has no entry for every model OpenRouter routes to, so `costUsd` used to read as
  `-` for any model outside the catalogue — `anthropic/claude-sonnet-5` among them. OpenRouter
  already returns the real cost on `usage.cost` for both streaming and non-streaming responses;
  this reads that value straight off the response and prefers it over the price-table estimate,
  falling back to the table only when a provider doesn't report its own cost.

  Sub-agent calls (`context`, `search`, `planner`, `reviewer`, and spawned agents) report their cost
  the same way. They previously passed only token counts through to the tally, so a delegated call
  on a model outside the price table contributed nothing at all and left the session total flagged
  as partial.

- 1ddcb49: Fix four ways the workspace `search` tool put wrong or wasteful content into an agent's context.

  The truncation notice `cappedRead` appends was being scanned as if it were a line of the file, so
  searching for a word in it reported a match at a line number the file does not have. Binary files
  are now skipped the way grep skips them, instead of decoding to replacement characters and
  matching. A single hit in a minified or bundled file returned the whole line — up to 256 KiB for
  one match — and is now clipped to a window centred on the match. Generated output directories
  (`target`, `out`, `vendor`, `.gradle`, `Pods`, `.terraform` and others) are skipped alongside the
  ones already listed — and that skip list is now applied only to directories, so an ordinary file
  that happens to be named `build` or `vendor` is searched instead of silently passed over.

  `search` also now says when a file was only read up to its per-file cap, and when binaries were
  skipped — including on a "no matches" result, where "nothing found" in a partly-read file is a
  weaker claim than it looks.

  A sub-agent that fails to construct (`context`, `search`, `planner`, `reviewer`) now logs
  `SUBAGENT_UNAVAILABLE` with the provider error instead of disappearing from every turn silently.

- Updated dependencies [1ddcb49]
- Updated dependencies [1ddcb49]
- Updated dependencies [1ddcb49]
- Updated dependencies [1ddcb49]
- Updated dependencies [1ddcb49]
  - @agentionai/marshall-tools@0.7.1

## 0.20.0

### Minor Changes

- 645123a: Add `list_conflicts` and `resolve_conflicts` tools for resolving git merge, rebase, and cherry-pick conflicts. `list_conflicts` reports each unresolved hunk with a short content-hashed id, its line range, ours/theirs labels and commit ids, and a few lines of surrounding context — without needing the whole file in context. `resolve_conflicts` takes those ids back with `ours`, `theirs`, or `both` to keep for each — one or many in a single call — and applies them directly, gated behind the normal approval flow.

### Patch Changes

- Updated dependencies [645123a]
  - @agentionai/marshall-tools@0.7.0

## 0.19.0

### Minor Changes

- Remove the fixed 32768-token output cap that llama.cpp and Ollama profiles
  got by default. It existed to stop an uncapped local server from generating
  until its context window ran out, but a reasoning model can legitimately
  need more than that just to finish thinking — a long-running turn now dies
  with "Response exceeded maximum token limit" instead of ever reaching an
  answer. Local providers are now uncapped by default like every hosted one
  except claude, matching `--max-tokens`'s existing per-session override.
  `Session.skipReasoning()` (Ctrl-E) is the actual answer for a run that's
  taking too long, not a blanket ceiling.

## 0.18.0

### Minor Changes

- Bump `@agentionai/agents` to `1.10.3`, and add `Session.skipReasoning()`, which
  tells a llama.cpp coder or side-agent to end its reasoning phase early via
  llama.cpp's `/v1/chat/completions/control` endpoint, without aborting the turn.
  Bound to Ctrl-E in the CLI, shown as "ctrl-e to skip thinking" in the status
  row while a llama.cpp agent is reasoning. A no-op on every other provider.

### Patch Changes

- Updated dependencies
  - @agentionai/marshall-tools@0.6.5

## 0.17.0

### Minor Changes

- Cerebras is now a first-class provider (`cerebras`), alongside claude/openai/gemini/mistral/ollama/llamacpp/openrouter. It defaults to `https://api.cerebras.ai/v1` and `CEREBRAS_API_KEY`, shows up in the `/model` setup wizard with a live model catalogue, and defaults to `llama-3.3-70b`. Previously it had to be configured manually as a named `openai-compatible` endpoint.
- e8c002e: `spawn_agent`'s `tier` argument is gone; delegating to the fast tier is now
  `agent_name: "fast"`, the same field used for a saved named agent. Previously
  `tier` (`fast`/`deep`) and `agent_name` were separate, mutually-exclusive
  arguments — a model could still ask for a bare `deep`-tier spawn. That option
  is removed: an ad-hoc spawn is now always `"fast"` or a configured named
  agent, matching the guidance that delegated work should either be mechanical
  (fast) or handed to a persona built for it.

### Patch Changes

- e8c002e: Fix a turn interrupted mid-tool-call (during approval or execution) leaving
  an unanswered tool call in history. A provider that requires every call to be
  answered rejected the _next_ request outright ("No tool output found for
  function call ..."), and because that 400 carried no context-length wording,
  it was misread as context overflow and sent through a compression pass that
  could never fix it. Interrupting now patches the dangling call with a
  synthetic cancelled result before the next turn can see it, and the
  misdiagnosis is closed off directly with a classifier that recognises this
  error shape instead of guessing.
- e8c002e: Raise the default safety-judge output cap from 1200 to 4096 tokens. Local
  hybrid-thinking GGUF models (and other reasoning-tuned judges) can emit a
  chain-of-thought preamble well past 1200 tokens before their verdict, which
  threw `MaxTokensExceededError` instead of ever producing a decision.
  `safetyAgent.maxOutputTokens` still overrides this per judge for models that
  need more.

## 0.16.2

### Patch Changes

- 19114de: Fix reasoning-model agents failing with "Response incomplete: max_output_tokens".
  The engine omits the output cap for hosted OpenAI so the model's own ceiling
  applies, but the installed agents SDK falls back to 1024 when the field is
  missing — and a gpt-5/o-series model spends those 1024 output tokens reasoning,
  then emits no visible text and errors. Reasoning models now get a real default
  output cap (8192). Reasoning-model detection is prefix-tolerant, so it also
  covers OpenRouter ids like `openai/gpt-5.6-luna`.

## 0.16.1

### Patch Changes

- 4e87b59: Fix the safety judge crashing against gpt-5/o-series reasoning models: `temperature` is omitted for reasoning-model profiles instead of being sent as `0`, which those models reject with a 400. Temperature handling on plain chat models is unchanged.

## 0.16.0

### Minor Changes

- Let `spawn_agent` target a saved named agent by name (`agent_name`) instead of only a bare tier,
  and optionally fix a named agent to one toolset.

  `EngineConfig` gains an optional `namedAgents` list. When it's non-empty, `spawn_agent`'s tool
  schema advertises `agent_name` alongside `tier` (exactly one expected), resolves the named
  agent's own model and credential instead of a tier's, and carries its description into the
  spawned agent's system prompt. When no named agents are configured, the schema is exactly what
  it was before this existed, so a project that hasn't used the CLI's new `/team` command sees no
  difference in what the model is offered.

  A named agent can also fix its own `toolset` (`readonly`/`edit`/`full`). When set, it's
  authoritative — a "tester" pinned to `edit` runs on `edit` even if the caller asks for `full`,
  and the caller isn't asked for a toolset at all when spawning it. Unset, an agent behaves exactly
  as before: the caller picks a toolset per spawn.

- 6785c92: Fix a prompt silently dropped when it was typed the instant a finished background job or agent
  woke the coder back up, and Esc doing nothing during `/plan`, `/goal` or `/review`.

  `Session` used to announce a turn's `thinking` event only after that turn's setup (MCP
  settling, compression, building the agent) finished, so a client watching the session had no way
  to tell "about to be busy" from "already busy." A prompt submitted into that window reached
  `run()`, hit its concurrency guard, and was reported as an error and lost rather than queued.
  `Session` now announces a turn the moment it claims the session, and exposes a new `busy` getter
  so a client isn't left inferring session state from the event stream. The CLI now queues a
  prompt typed into that window instead of losing it.

  Separately, `/plan`, `/goal` and `/review` never checked for an interrupt before their model
  call and never raced the call itself against one, so pressing Esc during setup or while the
  call was in flight did nothing — the run() path already handled both correctly, and the two
  now share one implementation so a fix to this class of bug can't land in one and miss the
  other.

### Patch Changes

- 6785c92: Stop a transient failure to build the summariser from disabling context compression for the
  rest of the session.

  `CompressionManager` set its `ready` flag before the summariser agent was actually built, so a
  failure creating it (an unreachable model, say) left `ready` true with no working summariser
  behind it — compression was then silently skipped for every later turn, even after a model
  switch made the summariser reachable again. `ready` is now reset on that failure, so the next
  attempt (the next turn, or `invalidateModel` after a switch) retries instead of short-circuiting
  on the stale flag.

- Updated dependencies [6785c92]
  - @agentionai/marshall-tools@0.6.4

## 0.15.1

### Patch Changes

- Republish the named OpenAI-compatible provider support in a patch release.

## 0.15.0

### Minor Changes

- Add named OpenAI-compatible providers. Custom endpoints can be saved, selected by name during setup, and shown by name in the active model banner.

## 0.14.0

### Minor Changes

- 888f2d1: Spawn background agents on `/runtime agentic`.

  Adds a session-scoped `AgentJobs` registry alongside `BackgroundJobs`, and the
  `spawn_agent` / `agent_list` / `agent_output` / `agent_kill` tool belt behind the
  new agentic runtime mode. Only `spawn_agent` is gated: consent is given once to a
  brief, and every action the agent takes is judged against that brief.

  Each spawned agent gets its own `readFiles` map and dedupe cache but shares the
  session `fileLock`, so two agents editing one file still serialise. It gets no
  jobs, no `ask_user` and no `spawn_agent`, which is what bounds depth.

  `RuntimeMode` replaces the `light` boolean as a single value, so light and
  agentic cannot be set at once. `/agents` lists and stops what is running; a
  finished agent wakes the parent through the same `pendingJobReports` path as a
  shell job, with its own resume wording.

  The engine now exports the `AgentJob`, `AgentJobs`, `AgentJobStatus`,
  `AgentToolset`, `SwarmRole` and `RuntimeMode` types plus `summariseAgentJob`.
  Spawned agents carry no default time ceiling — one runs until it finishes or is
  `agent_kill`ed — but a per-`spawn_agent` stop can be imposed via the new
  `agentTimeoutMs` config option.

### Patch Changes

- 888f2d1: Narrow what compression folds instead of folding the whole overflow into one summary.

  `middleCompressionPlugin` replaces the flat library summariser. It keeps the
  first conversational turn and a short tail of the newest turns verbatim, and
  summarises only a contiguous middle window that fits in bounded steps. When the
  window already contains a prior summary, that summary is extended in place
  (picking up its `coversRange`) rather than discarded and rebuilt. Reducing
  stops as soon as a step makes no token progress, so the summariser never spins
  re-emitting what is already there.

  The result is smaller, cheaper summary prompts (each step folds ~3k tokens, well
  under a local model's context window) and an older context that keeps more real
  turns than a single all-or-nothing summary.

- 5dad6d5: Hoist the per-path write lock to session scope, so every tool belt that can
  write queues on the same one.

  `createFileTools` owned its lock, which orders only the calls made through that
  one belt. That was enough while a single agent did the writing: the belt is
  rebuilt each turn, but only one exists at a time. It stops holding as soon as a
  second belt can write, because each belt takes its own private lock and the two
  serialise against nothing — which is exactly the read-modify-write race the lock
  was built to prevent, back where it started and now invisible.

  `ToolConfig.fileLock` is injected the same way `readFiles` already is, and for a
  reason of the same shape: the lifetime belongs to the session, not the belt.
  Absent, the factory still makes its own, which is what the tests and any
  single-writer belt want.

- Updated dependencies [5dad6d5]
  - @agentionai/marshall-tools@0.6.3

## 0.13.4

### Patch Changes

- 97586e5: Bump `@agentionai/agents` to `1.7.0-beta.0`.

  The new beta includes the `AgentJobs` registry and `spawn_agent`
  tool support that the swarm feature depends on. The CLI version is
  bumped to `0.15.0` to reflect the new `/agents` command and the
  runtime/safety settings persistence.

- 60362c9: Safety agent now strips markdown fences before parsing JSON verdicts.

  `stripFence` removes ` ```json ... ``` ` and ` ``` ... ``` ` wrappers
  from model output so the verdict parser can handle models that wrap
  their JSON response in a code block. Previously a fenced response
  would fail to parse and the call would be denied by default.

- 5dad6d5: Hoist the per-path write lock to session scope, so every tool belt that can
  write queues on the same one.

  `createFileTools` owned its lock, which orders only the calls made through that
  one belt. That was enough while a single agent did the writing: the belt is
  rebuilt each turn, but only one exists at a time. It stops holding as soon as a
  second belt can write, because each belt takes its own private lock and the two
  serialise against nothing — which is exactly the read-modify-write race the lock
  was built to prevent, back where it started and now invisible.

  `ToolConfig.fileLock` is injected the same way `readFiles` already is, and for a
  reason of the same shape: the lifetime belongs to the session, not the belt.
  Absent, the factory still makes its own, which is what the tests and any
  single-writer belt want.

- Updated dependencies [97586e5]
- Updated dependencies [5dad6d5]
  - @agentionai/marshall-tools@0.6.2

## 0.13.3

### Patch Changes

- f7bbefc: Fix the `openai` and `gemini` providers, which both failed on the first request
  of every session, by taking `@agentionai/agents` 1.6.0-beta.0. Three bugs, all
  fatal on their own and all fixed upstream:

  - OpenAI tool definitions went out with `strict: true` unconditionally, and
    OpenAI rejects a strict schema whose `required` list does not name every
    property — so the ten tools with an optional parameter (`read_file`'s line
    range, `search`'s path filters, the `gh_*` filters) turned into a 400 before
    the model ran.
  - Gemini tool results were sent as a bare JSON string where the API types
    `functionResponse.response` as a protobuf Struct, which came back as a 400
    quoting the whole tool output.
  - the `thoughtSignature` Gemini 3 returns with each function call was dropped by
    the history transformer, so replaying the call failed with "Function call is
    missing a thought_signature". Gemini 2.5 did not require them and is no longer
    offered on new API keys, so this affected every model a new user can reach.

  A bad request that compression cannot shrink and that never mentions context
  also stops being reported as "context window full", which is how the OpenAI one
  hid: the CLI reported a full context window over a 921-token history.

- e26473b: Persist runtime and safety settings, and replace `/light` with `/runtime`.

  **Breaking:** `/light` is now `/runtime [default|light|agentic]`. The old command
  toggled; the new one names the mode you want, and remembers it. `/runtime` on its
  own reports the current mode. Add `--global` to save it for every workspace
  instead of just this one. It is not called `/mode` because that is a strict
  prefix of `/model`, which made tab completion rewrite a complete, valid command
  into a different one.

  Safety levels 2 and 3 are now persisted too, together with the judge model chosen
  by `/safety agentic`, so turning a real approval gate on is not something you have
  to redo every morning. Level 1 (`yolo`) is deliberately never written: a gate that
  disables itself again on the next launch, from a file that can be committed, is
  not a decision anyone should be able to make once. The stored judge records
  provider, model and host but never an API key, and is authenticated at load time
  from the global config or the provider's environment variable.

  All non-secret settings now live under a versioned `settings` key in
  `.marshall/config.json` or the global config, with one reader and one writer
  (`services/settings.ts`). A settings block from an unrecognised version is ignored
  rather than half-read, invalid values are reported at startup rather than silently
  applied, and a level-3 gate whose judge cannot be validated is read back as level 2
  rather than as no gate at all.

  Fixes along the way:

  - An `apiKey` in the project-local `.marshall/config.json` is now ignored and
    reported, wherever in the file it appears. That file is meant to be committed.
  - Choosing a model no longer wipes the rest of the global config. `saveConfig`
    rebuilt the file from the model tiers alone, so a configured MCP server or
    settings block survived exactly one `/model`.
  - A project config pinning one provider's host no longer erases the API key stored
    globally for that same provider.
  - `Session` gained a `safetyAgent` getter. Reading the gate back off
    `safetyAgentProfile` dropped `kind` and `maxOutputTokens`, which silently
    downgraded a content-safety judge to the default chat-judge shape.
  - The header's `mode` row now tracks `/runtime` instead of showing the value it
    booted with.

- Updated dependencies [f7bbefc]
  - @agentionai/marshall-tools@0.6.1

## Unreleased

### Patch Changes

- Persist runtime and safety settings, preserve validated safety-agent profiles, and report invalid or unsafe project configuration without accepting credentials from workspace files.
- Improve provider error reporting by distinguishing rate limits and quotas, including retry guidance, and avoid misreporting unrelated bad requests as context-window exhaustion.
- Fix OpenAI and Gemini tool calls and history handling through `@agentionai/agents` 1.6.0-beta.0, including strict tool schemas, structured Gemini tool responses, and Gemini thought signatures.

## 0.13.2

### Patch Changes

- Improve concurrent approval handling and bound tool transcripts included in history compression prompts.

## 0.13.1

### Patch Changes

- Improve concurrent approval handling so “always approve” cascades to matching queued tool calls, and bound tool transcripts passed to history compression prompts.

## 0.13.0

### Minor Changes

- 6cce94b: Identify Marshall to OpenRouter, so its traffic is attributed to the app.

  Every request on an `openrouter` profile now carries OpenRouter's app-attribution
  headers: `HTTP-Referer: https://marshall.agention.ai` (the identifier the
  rankings and the per-app analytics key on), `X-OpenRouter-Title: Marshall` (the
  display name) and `X-OpenRouter-Categories: cli-agent`. Without the referer
  there is no app page at all, so a title on its own would have done nothing.

  They ride on the agent library's `defaultHeaders`, which requires
  `@agentionai/agents` 1.4.0 — the dependency moves with it.

  They are sent for gateway hosts too, not just openrouter.ai: a proxy in front of
  OpenRouter forwards them, and anything else ignores headers it does not know.
  Nothing about the request itself is disclosed, and no other provider is touched.

## 0.12.0

### Minor Changes

- Report what a session spends: tokens, cost and throughput.

  A new usage tally collects from every agent separately and rolls sub-agents into
  the turn that fanned them out — the coder's own counter is all a provider hands
  back, and it makes a turn that spent most of its tokens inside three parallel
  `context` calls look nearly free. `Session.usageReport()` returns the session
  total plus a breakdown per role and model, and the `usage` event now carries
  turn and session rollups, sampled while the turn runs rather than only at the
  end.

  Cost is computed from prices the client supplies through `Session.setPricing()`.
  Self-hosted providers are priced at a known zero, so a llama.cpp fast tier
  alongside a hosted deep tier still totals exactly rather than reporting a floor.
  A total is omitted rather than shown as `$0.00` when nothing that ran had a
  published price.

  Throughput comes from `@agentionai/agents` 1.3.0, which times each API call from
  the inside and sums across a tool-use loop, so tool execution and approval waits
  are excluded. Two corrections on top of the raw figures, both for reasoning
  models that do not stream their thinking: the output rate divides only the
  tokens that were actually streamed, and the input rate is withheld when anything
  was produced off-screen, since time-to-first-token is then mostly generation.
  The wait is reported as a duration instead.

  Requires `@agentionai/agents` ^1.3.0.

## 0.11.0

### Minor Changes

- a48a143: Add `MARSHALL_TRACE_HISTORY`, which writes the conversation as the model receives
  it to `.marshall/logs/history.log`, once before and once after every turn.

  The session log records the task and the tool calls but never what was sent, so
  "the agent forgot the previous answer" had no answer short of instrumenting the
  engine by hand — a missing history entry, one the masking plugin rewrote on the
  way out, and a model that simply ignored the context all look identical from
  outside. The `before` record for a turn is exactly the document the model was
  given for it, and tool results a transform changed are marked `[masked]`.

  `=full` skips truncation. Off by default, and the file quotes your code, so treat
  it the way you would the source it came from.

## 0.10.0

### Minor Changes

- 78df418: Add safety level 3: a model reviews each tool call before you do.

  `EngineConfig.safetyLevel` is now `1 | 2 | 3` — no gate, human-in-the-loop (the
  default, unchanged), or agent-reviewed. At level 3 a dedicated judge model sees
  each state-changing call first. A confident "safe" verdict approves it outright
  and you are never interrupted; an "unsafe" verdict does _not_ block, it annotates
  the approval with the judge's reasoning and still asks you, so a false positive
  costs a keystroke rather than the task. A judge that fails, times out or answers
  unparseably also defers to you. The judge can only ever skip asking about things
  it is confident are fine.

  In the CLI: `/safety [none|default|agentic]`, session-only like `/light` rather
  than persisted, with `agentic` opening the model picker to choose the judge. The
  banner shows a `safety` row whenever the level is not the default, and each
  verdict appears in the transcript under the call it judged — approvals included,
  since a call you were never asked about is exactly the one whose review would
  otherwise be invisible. Every judge call is logged in full to
  `.marshall/logs/session.log`.

  Two judge prompt shapes are supported: `chat-judge` for ordinary
  instruction-following models, and `nvidia-content-safety` for guard-style
  classifiers. Testing against real local models says to prefer the former, even a
  small fast one, and to judge a judge by its false-approve rate rather than raw
  accuracy — a denial still reaches you, an approval does not. See
  `docs/agent-based-safety.md`.

- 78df418: Fix two ways concurrent tool calls lost work or consent.

  Models routinely batch several file calls into one message, and the agent SDK
  runs that batch concurrently. Both of these were live, not theoretical.

  **Edits to one file raced.** `edit_file` reads, computes and writes across an
  `await`, so parallel edits all read the same original and only the last write
  survived — while every call still reported `Edited`. Writes to a path are now
  serialised, keyed per path so edits to _different_ files still run in parallel.
  Whole-file writes cannot be fixed by serialising, since each carries complete
  content built from the same read, so `write_file` now refuses a write whose
  expectation of the file no longer matches disk and points at `edit_file`, which
  composes. A write composed before someone hand-edits the file in their editor is
  refused for the same reason, instead of silently discarding their change.

  **One approval answered for calls you never saw.** The gate coalesced in-flight
  requests by tool name, so a batch of writes to three different files cost one
  prompt: you were shown one file, and approving it wrote the other two unseen.
  Denying one denied all three. Requests now key on the tool, the arguments and
  the calling agent, so only genuinely identical calls share a decision.

  **You will see more prompts than before.** A batch of three writes to three
  files now asks three times, because it always should have. `ToolCaller` also
  gains an optional `id` naming the agent instance rather than its role, so two
  agents on one role are not treated as one actor by the gate, the approval panel
  or the safety judge.

  Read tracking (`read_file` before writing an existing file) moves to session
  scope via `ToolConfig.readFiles`, fixing a case where reading a file in one turn
  and editing it in the next failed with "has not been read this session".

### Patch Changes

- 78df418: Stop publishing compiled test files.

  `files: ["dist"]` ships dist wholesale and the build compiled everything under
  `src`, so every release carried its own test suite — 11 compiled test files in
  the engine tarball alone, plus their fixtures. Builds now run against a config
  that excludes tests, while `typecheck` still covers them.
  `@agentionai/marshall-engine/testing` is unaffected: the fake provider is a real
  export, not a test.

- Updated dependencies [78df418]
- Updated dependencies [78df418]
- Updated dependencies [78df418]
  - @agentionai/marshall-tools@0.6.0

## 0.9.0

### Minor Changes

- Add an `ask_user` tool so an agent can ask a genuine question mid-task.

  The tool surfaces a question to the user — with optional numbered options,
  multi-select and a free-text "Other" — and returns their answer to the model.
  It is wired up end-to-end: `packages/tools` provides `createAskTool`, the engine
  exposes it on the belt whenever the client implements `askUser` (beyond approval,
  which only happens over a state-changing action), and the CLI renders it with a
  dedicated `QuestionPanel` that queues parallel questions and chains through them
  one at a time.

  Prompt guidance was added so the model treats it as a tool for genuine ambiguity
  that blocks progress, not a confirmation dialog — the same rule the accompanying
  system prompt carries.

  Usage: `npm run cli`, then ask the agent something open-ended it cannot infer
  (which target, which stack, which direction) and it can stop and ask.

### Patch Changes

- Updated dependencies
  - @agentionai/marshall-tools@0.5.0

## 0.8.0

### Minor Changes

- 958e40f: Add typeahead search to the model picker and include OpenRouter content-safety models, including free NVIDIA Nemotron guardrails, in the catalogue.

## 0.7.0

### Minor Changes

- 81cac61: Add a fake OpenAI-compatible model server, exported as `@agentionai/marshall-engine/testing`.

  Every test so far stopped at the edge of the provider, so nothing covered the loop that
  actually breaks: a tool call reaching a tool, the approval gate sitting between the two, a
  job exiting and waking the agent. `startFakeProvider` serves `/v1/chat/completions` in both
  shapes the engine uses — SSE for `run()`, one JSON body for `/plan` and `/review` — from a
  scripted list of turns, and records what the model was sent. A test points an
  `AgentProfile.host` at it and everything below stays real: the `openai` SDK, the tool-call
  loop, the tool belt, the event stream.

  New integration suites cover a gated `write_file` end to end, the denial path, an
  interrupted turn, and a background job auto-resuming a turn on its own.

- 81cac61: Add light mode — a lean tool belt for small models.

  `--light`, `"light": true` in config, or `/light` in the session. It drops the scratchpad
  (`note_*`/`log_*`), background jobs (`run_shell`'s `background` option and the `shell_*`
  tools) and every sub-agent (`context`, `search`, `planner`, `reviewer`), leaving
  read_file/list_dir/search/write_file/edit_file/run_shell. Measured on a tiered setup: 16
  tools down to 7, and the fixed per-request overhead from ~2130 tokens to ~955 — a 55% cut,
  which on an 8k local model is a quarter of the window handed back.

  The system prompt is now built from the belt rather than being a fixed string. It had
  hardcoded rules about `note_write`, `log_append` and backgrounding, and a rule describing a
  tool the model does not have is worse than no rule: it spends tokens teaching a call that can
  only fail. `buildSystemPrompt` composes only the rules whose tools are present, which is the
  same way the `context`/`planner`/`reviewer` guidance blocks already worked.

  `/light` takes effect on the next message, since the belt and prompt are rebuilt per turn.

### Patch Changes

- 81cac61: Show OpenRouter model pricing and capability metadata in the model picker.

## 0.6.1

### Patch Changes

- ccccc7f: Stop `/goal` from looping on its own read-file instructions.

  `GOAL_AGENT_PROMPT` told the model to read files to "verify its understanding" before
  answering. On a small local model this sent it into a stuck loop re-issuing
  `list_dir`/`read_file` on a near-empty new project, since there was nothing there for "verify
  what exists" to find. The goal is answerable from the task description alone far more often
  than a concrete implementation plan is — read-only tools are still available if a task
  genuinely needs them, but nothing in the prompt pushes toward using them now.

## 0.6.0

### Minor Changes

- 6f94195: Add `/goal`, a destination-first sibling to `/plan`.

  `/plan` starts from "what steps"; `/goal` starts from "what does done look like" and only
  sketches a rough breakdown once that's pinned down — success criteria and scope stay separate
  from exact files and edits, which is still `/plan`'s job. Runs on the same tier as `/plan` and
  shares its pending-context slot, so the result primes the next task the same way a plan does.

### Patch Changes

- 6f94195: Recover from a full context window instead of failing the turn.

  llama.cpp's small local context windows were surfacing raw 400s to the user, sometimes after a
  multi-attempt retry storm that still failed. The token estimate used to size compression is
  unreliable for code-heavy content, so guessing a fixed compression target or retrying blindly
  wasted time and often failed anyway.

  A context-length error now triggers one bounded compression pass — `reduceToTarget` walks down
  in small steps so no single summarisation prompt can itself blow the same small context window
  it's trying to recover from — sized to the actual measured overage in the provider's own error
  rather than a flat percentage of the window. The task is then handed back to the user via the
  existing steering-context mechanism (same as an Esc-interrupt) instead of auto-retrying, and the
  CLI shows a plain "context window full" message instead of the raw provider error.

  Also: the summariser agent's own history is now transient, so repeated compressions in one
  session don't silently accumulate their own unbounded context; and provider error details
  (status, response body) are now logged end-to-end for diagnosing recovery in production.

- Updated dependencies [6f94195]
  - @agentionai/marshall-tools@0.4.1

## 0.5.0

### Minor Changes

- c6a82b9: Connect remote MCP servers over HTTP and use their tools.

  `adaptMcpTools` wraps the tools Agention's `MCPClient` discovers so they obey the
  same contract as the builtin belt: namespaced (`mcp__<server>__<tool>`) so a
  server cannot shadow `read_file`, never throwing, always returning a string,
  bounded by a timeout and the task's abort signal, and gated by approval —
  provenance is unknowable, so consent is mandatory. `McpRegistry` in the engine
  owns connection lifecycle; an unreachable server degrades to a reported error
  rather than a broken session.

  The CLI gains `/mcp`, `/mcp add` (a wizard for url, name, token and scope) and
  `/mcp remove|reconnect <name>`. Server definitions and their credentials live in
  the global config at `0600`; a project's `.marshall/config.json` may only select
  from them via `mcp.enable`/`mcp.disable`, and credentials on a project-declared
  server are stripped on read, since that file is meant to be committed.

  Also lays the groundwork for automated approval: `ApprovalRequest` now carries
  structured `input` and a `source` describing where the tool came from, and the
  session resolves approvals through an ordered chain of `ApprovalDecider`s that
  can each defer. An agent that judges requests and escalates only the risky ones
  becomes one entry in that chain, with no tool changing.

- dfdeb9a: Background shell commands that outlive the turn that started them.

  `run_shell` takes a `background` option: it returns a job id immediately instead of blocking, and the agent carries on. New `shell_output`, `shell_kill` and `shell_list` tools read and manage running jobs, backed by a session-scoped `createBackgroundJobs` registry that must be injected as `ToolConfig.jobs` (and killed via `killAll()` on teardown).

  When a job finishes, its result is fed back into the conversation and — unless `autoResume: false` — the engine starts a turn to act on it, capped by `autoResumeBudget` (default 4) consecutive unattended turns. The CLI gains `/jobs` and `/jobs kill <id>`.

### Patch Changes

- Updated dependencies [c6a82b9]
- Updated dependencies [dfdeb9a]
  - @agentionai/marshall-tools@0.4.0

## 0.4.0

### Minor Changes

- Attach images to a task with ctrl-V.

  `Session.run()` takes an optional list of image attachments and sends them as
  content blocks alongside the task text. Ctrl-V reads the image off the system
  clipboard — terminal paste cannot carry one, since bracketed paste is a text
  protocol — using wl-paste or xclip on Linux, pngpaste on macOS, and PowerShell
  on Windows, and names what to install when none is present.

  Providers that cannot carry an image are refused before the request is spent
  rather than after: ollama drops image blocks silently, so the model would
  otherwise answer confidently about something it never received, and mistral
  accepts images only by URL. Images are capped at 5MB.

- Model discovery moved into the engine and is now exported: `parseLlamaCppModels`,
  `applyLlamaCppProps`, `parseOllamaModels`, `parseOpenRouterModels`, the
  `formatContext` / `formatParams` / `formatBytes` helpers, and the `ModelInfo`
  type. These parse what llama.cpp, ollama and OpenRouter report about the models
  they serve, which is provider knowledge rather than presentation — any client
  with a model picker needs it.

## 0.3.0

### Minor Changes

- Rename from @marshall/_ to @agentionai/marshall-_

### Patch Changes

- Updated dependencies
  - @agentionai/marshall-tools@0.3.0

## 0.2.0

### Minor Changes

- Initial release

### Patch Changes

- Updated dependencies
  - @agentionai/marshall-tools@0.2.0
