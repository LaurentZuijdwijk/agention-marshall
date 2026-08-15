# @agentionai/marshall-engine

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
