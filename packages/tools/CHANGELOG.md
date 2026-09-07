# @agentionai/marshall-tools

## 0.9.2

### Patch Changes

- b41d7c5: The read gate judges a read by what it rendered, not by how it was asked for.

  `write_file` needs the whole file read first. Told to "call read_file again without a line
  range", a model asked for lines 1–100000 instead — every line — and was refused as a partial
  read; then a full read did unlock the write, and two ranged re-reads of one section of the
  unchanged file locked it again. Meanwhile the oversized-edit refusal was telling it to use
  `write_file`, which it could not. It gave up and spent four minutes editing the file in pieces.

  A ranged read that renders every line now counts as complete, and a ranged re-read of a file
  already read whole keeps that coverage as long as the file's hash is unchanged — the moment the
  file moves on, a ranged read is partial again. The oversized-edit refusal from `edit_file` and
  `edit_lines` now says, when the read on record would not unlock `write_file`, what would.

## 0.9.1

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

## 0.9.0

### Minor Changes

- Add browser control and screenshots for the coding agent, via a new local MCP server (`@agentionai/marshall-plugin-browser`) backed by a companion Chrome extension (`packages/browser-extension`, unpublished). Screenshots reach the model as real vision input: MCP tool results can now carry image content that lands in front of the model on the next turn, via a new `ToolConfig.attachImages` — any MCP server returning image content benefits, not just this one. `browser_read_page` supports a token-cheap `text` mode (default) and a full `html` mode. The extension shows a small on-page indicator while Marshall is driving a tab, hidden automatically during a screenshot.

  Also adds a minimal, real slice of the plugin system: a `plugins` config array and a `/plugins add|disable|list` command that spawns a locally-managed plugin's server, health-checks it, and auto-registers it as an MCP server — no more hand-editing `mcpServers` or re-pasting a pairing token every session. `/plugins add browser` is the first consumer.

- Split line-addressed replacement out of `edit_file` into its own `edit_lines` tool. `edit_file` now only accepts `oldString`/`newString`, with a fully-specified schema (`required` on both fields — previously impossible, since one `edits[]` entry had to validate against two different shapes). `edit_lines` takes `startLine`/`endLine`/`newString` and keeps the same read-before-line-edit safety gate `edit_file` used to enforce for that case, plus a bare top-level fallback symmetric with `edit_file`'s (a call with `startLine`/`endLine` and no `edits` wrapper now works, instead of failing with an unexplained "no edits given").

## 0.8.0

### Minor Changes

- 81d7345: Batch `edit_file`, `search` and `list_dir`, and render `read_file` without a gutter.

  `edit_file` now takes `edits[]` — every disjoint change to one file in a single call, each
  `oldString` matched against the file as last read and applied in reverse offset order, so
  earlier replacements never shift later ones. Failures are reported per index and the file is
  left untouched unless every edit resolves. The single `oldString`/`newString` pair still works
  and is folded into a one-element batch, so no existing caller breaks. `search` and `list_dir`
  gain the same shape (`patterns[]`, `paths[]`) for the same reason: several unrelated greps or
  listings are one round trip rather than one each. A one-item batch renders exactly as the
  single-item call always did.

  The measurement behind it: a 28-file migration spent 143 `edit_file` calls on work that batches
  into 28. The cost of a call is not its payload — runs whose payloads were _larger_ emitted
  60-108% fewer output tokens than runs with many small ones — but the per-call envelope, the
  repeated path, and the model's own preamble around each one.

  `read_file` no longer prefixes a `12 | ` gutter by default. `Limits.readLineNumbers` restores it
  for programmatic callers of the engine; the CLI does not yet surface `limits`, so there is no
  setting for it there. A gutter makes content easy to refer to and impossible to copy: `edit_file` matches an
  exact string, so every `oldString` had to be reconstructed rather than lifted from what was just
  read. Model reasoning traces showed each pair being drafted in full inside `<think>` before being
  emitted again as arguments, then repaired when that went wrong.

  When an `oldString` misses exactly, a fallback is tried once against a normalized copy, with an
  offset map so the bytes replaced are the real ones. It is narrower than "whitespace-tolerant":
  it folds smart quotes and unicode dashes to ASCII and ignores _trailing_ whitespace per line.
  Interior runs of spaces are still significant, so `a  b` does not match `a b`. A curled quote or
  a dropped trailing space no longer costs a full re-emission of the edit body. Because a
  loose match means the caller's idea of that text has drifted from the file's, the result now says
  so; an exact match reports nothing extra.

  A bare `*` or `**` `fileGlob` now means "every file", as it reads. It was matched as a literal
  substring, so it selected no ordinary filename and reported the glob as the reason nothing was
  searched — a wasted round trip for an input meaning exactly what no glob at all already means.

  **`edit_file` no longer requires the file to have been read first.** The `oldString` is the
  evidence: it has to occur exactly once in the file as it stands, so an edit built on content the
  caller came by some other way — a shell `cat`, a search hit, a file it just wrote — either lands
  where it was meant to or fails `not-found`/`ambiguous` and says so. The read requirement bought no
  safety on top of that and cost a round trip per file; measured on a 28-file migration, it was the
  difference between 37 `read_file` calls and 10. It also blocked an ordinary case outright: editing
  a file you have just written yourself.

  Two things deliberately keep the gate. `write_file` still needs a complete prior read, because it
  replaces the whole file including the parts never looked at and has no `oldString` to validate
  against. Line-addressed edits (`startLine`/`endLine`) still need one too — line 12 is whatever line
  12 currently is, so the request carries no evidence and is only meaningful against the version
  whose numbers the caller actually saw; that now has its own check and message rather than leaning
  on the blanket gate. Editing a file that does not exist reports that, instead of the raw `ENOENT`
  the blanket gate used to mask.

  `read_file`'s description now points at `run_shell` for taking in several files at once
  (`grep -rl PATTERN src | xargs cat`) rather than calling it once per file — honest advice only
  because the gate is gone, since content obtained that way is now enough to edit from.

## 0.7.1

### Patch Changes

- 1ddcb49: Fix line count reporting, partial reads, and line numbering in `read_file` to match grep and standard line numbering across long files.

  `read_file` and `search` now stream rather than reading whole files, so `maxFileBytes` bounds
  what is held in memory and not just what is printed — a file too large to hold as a string is
  still readable and searchable. Line ranges are validated: a reversed or non-numeric range is an
  error instead of a `NaN` header. `\r` is preserved, so an `edit_file` `oldString` copied out of
  a `read_file` render still matches a CRLF file.

  `write_file` now requires a read with no line range before replacing a file wholesale, and says
  which of the two reasons it is refusing for — a range read is fixed by re-reading without one,
  and only a file over the read limit needs `maxFileBytes` raised. An `edit_file` in between no
  longer counts as having read the file: matching a unique substring renders none of the rest, so
  a ranged read followed by an edit stays a ranged read rather than unlocking the overwrite the
  gate exists to refuse.

- 1ddcb49: Fix `read_file` sending a whole file over `maxFileBytes` in a single request when the file's
  first (or `startLine`-targeted) line is itself larger than the cap — a minified bundle or a
  one-line JSON dump, for example.

  The line-window reader always included a window's first line in full, on the reasoning that a
  window rendering nothing tells the model nothing. That had no upper bound of its own: a 480 KB
  single-line file bypassed `maxFileBytes` entirely and went out uncapped, which is what turned a
  routine tool call into a request large enough for a provider to reject as exceeding its context
  window. The oversized line is now clipped to fit the cap instead, and `read_file`'s truncation
  notice says so specifically — "this line exceeds the read limit on its own" rather than the
  generic "read another section," which was never the fix for a single huge line.

- 1ddcb49: `list_dir` now reports each file's size in bytes.

  Without it, a model choosing between `read_file` and `search` for a large single-line file (a
  minified bundle, say) had no way to know the file was large until after calling `read_file` on
  it — which, even correctly capped, can still mean tens of thousands of tokens of repeated content
  for a question `search` would have answered in a few hundred. Seeing the size up front is what
  lets a model prefer `search` for a file it can tell in advance is not meant to be read whole.

  Sizes are column-aligned without spreading one argument per entry into `Math.max`, which would
  have thrown on a directory large enough to overflow the argument list and lost the whole listing.

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

- 1ddcb49: Trim `list_dir` and `search`'s tool descriptions — wording only, no behavior change. Cuts about
  56 tokens of fixed per-turn overhead while keeping the parts proven this cycle to prevent real
  failures: the case-sensitivity flip between plain-name and regex search, and `fileGlob` being a
  name filter rather than a path.

## 0.7.0

### Minor Changes

- 645123a: Add `list_conflicts` and `resolve_conflicts` tools for resolving git merge, rebase, and cherry-pick conflicts. `list_conflicts` reports each unresolved hunk with a short content-hashed id, its line range, ours/theirs labels and commit ids, and a few lines of surrounding context — without needing the whole file in context. `resolve_conflicts` takes those ids back with `ours`, `theirs`, or `both` to keep for each — one or many in a single call — and applies them directly, gated behind the normal approval flow.

## 0.6.5

### Patch Changes

- Bump `@agentionai/agents` to `1.10.3`, and add `Session.skipReasoning()`, which
  tells a llama.cpp coder or side-agent to end its reasoning phase early via
  llama.cpp's `/v1/chat/completions/control` endpoint, without aborting the turn.
  Bound to Ctrl-E in the CLI, shown as "ctrl-e to skip thinking" in the status
  row while a llama.cpp agent is reasoning. A no-op on every other provider.

## Unreleased

### Patch Changes

- Make `edit_file` failure feedback more actionable by explaining that files must be read first, matches must include exact whitespace, and ambiguous matches need more surrounding context.

## 0.6.4

### Patch Changes

- 6785c92: Fix three ways a write tool could lose data: a truncated read authorizing a whole-file
  overwrite, a lost `log_append` entry under concurrency, and a file's permissions resetting on
  every atomic write.

  `write_file` compared its hash against `read_file`'s last snapshot to catch a stale overwrite,
  but a file larger than the read cap was hashed from only the observed prefix — so a whole-file
  write could go through on a hash that never saw the rest of the file, silently discarding
  anything beyond the cap. Whole-file writes are now refused unless the file was read in full;
  `edit_file` remains available for a targeted change to a large file.

  `log_append` read the log, then wrote it back, with nothing serializing two concurrent
  appenders — the session log's own lock now covers this the same way it already covers
  `write_file`/`edit_file`, so two agents (or a spawned agent and its parent) logging at once no
  longer lose an entry to a lost update.

  `atomicWrite` writes to a temporary file and renames it into place, which used to reset the
  destination's permissions to the new file's default mode. It now preserves the existing file's
  mode across the rename when there is one to preserve.

## 0.6.3

### Patch Changes

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

## 0.6.2

### Patch Changes

- 97586e5: Bump `@agentionai/agents` to `1.7.0-beta.0`.

  The new beta includes the `AgentJobs` registry and `spawn_agent`
  tool support that the swarm feature depends on. The CLI version is
  bumped to `0.15.0` to reflect the new `/agents` command and the
  runtime/safety settings persistence.

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

## 0.6.1

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

## Unreleased

### Patch Changes

- Update the OpenAI and Gemini provider integration through `@agentionai/agents` 1.6.0-beta.0, fixing tool definitions, Gemini tool responses, and thought-signature handling.

## 0.6.0

### Minor Changes

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

- 78df418: Show `write_file` approvals as a diff instead of a preview of the new content.

  `edit_file` already rendered a diff; `write_file` showed the first 800
  characters of what it was about to write and never compared against the file on
  disk. That was a way around the gate rather than a cosmetic gap: to change line
  200 of a long file without it appearing in the approval, an agent could avoid
  `edit_file` and rewrite the whole file instead, and the panel would show an
  unchanged, benign-looking prefix with the actual change sitting past the cutoff.

  What you are shown now scales with the size of the change rather than the size
  of the file, so there is nowhere past a cutoff to hide: a two-line change renders
  as two lines whether the file is 50 lines or 5,000, and an approval that looks
  empty means nothing changed. Where a diff is itself truncated you are told how
  many further changed lines exist. The summary line states the shape up front
  (`write_file: config.ts (+2 −1, 480 unchanged)`), since a whole-file write that
  changes two lines is the signature of exactly that manoeuvre.

  Creating a new file has nothing to diff against and still shows its content.

### Patch Changes

- 78df418: Stop publishing compiled test files.

  `files: ["dist"]` ships dist wholesale and the build compiled everything under
  `src`, so every release carried its own test suite — 11 compiled test files in
  the engine tarball alone, plus their fixtures. Builds now run against a config
  that excludes tests, while `typecheck` still covers them.
  `@agentionai/marshall-engine/testing` is unaffected: the fake provider is a real
  export, not a test.

## 0.5.0

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

## 0.4.1

### Patch Changes

- 6f94195: Fix the `search` tool's file matching, single-file targets, and invalid regexes.

  `fileGlob` matched anywhere in the full path, so a glob meant to filter by extension also
  matched directory names containing the same text; it now matches the basename only. `search`
  also rejected a direct file path (it only ever walked directories), threw uncaught on an invalid
  regex instead of returning an error, and had an off-by-one in its truncation flag. Per-file reads
  during a search are now capped so one huge file can't blow the budget.

## 0.4.0

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

## 0.3.0

### Minor Changes

- Rename from @marshall/_ to @agention/marshall-_

## 0.2.0

### Minor Changes

- Initial release
