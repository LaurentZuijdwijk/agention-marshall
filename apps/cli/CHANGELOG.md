# @agentionai/marshall-cli

## 0.14.1

### Patch Changes

- 876e80f: Fix a startup crash on macOS and Windows caused by two modules whose filenames
  differed only in case.

  `view/Markdown.tsx` (the React component) sat beside `view/markdown.ts` (the
  parser it imports), which built to `Markdown.js` and `markdown.js`. Those are
  distinct paths on a case-sensitive filesystem and the same path everywhere else,
  so unpacking the tarball wrote one over the other and the surviving module was
  missing the export the other's importer asked for.

  The component is now `view/MarkdownView.tsx`, exporting `MarkdownView`; the
  parser keeps the plain `markdown.ts`.

  Two things that let this ship, both fixed as well: nothing tested for the
  collision, since it is invisible on Linux where it was built, and `tsc` never
  removes stale output — so the rename alone would have left the old `markdown.js`
  in `dist` and shipped the collision anyway. Every package's build now clears its
  own `dist` first, and a test asserts no two source files differ only by case.

## 0.14.0

### Minor Changes

- Show token spend, cost and throughput in the status row.

  The row previously read "metrics unavailable" for the whole of every session:
  the usage event was gated behind the `/tokens` preference, which defaults to
  off. That gate made sense when the event pushed an opt-in transcript row, but it
  had since been repointed at an always-visible footer, which then spent its space
  saying its numbers were missing.

  It now fills in during the turn and reads, for example:

      ↑17,288  ↓1,500 (283 thinking) ~301/s  ·  17.0s  ·  3.8s→1st  ·  $0.0005

  Counts include every sub-agent the turn fanned out to; the rate describes the
  agent being watched, which is why the two sit side by side. Thinking is shown as
  a share of output rather than an addition to it, because that is how it is
  billed, and because without it the rate and the count do not appear to agree.

  `/tokens` becomes a report rather than a toggle — session total plus a line per
  role and model — since the toggle had nothing left to hide. Costs come from
  OpenRouter's public catalogue, fetched once in the background and only when a
  profile actually routes through it.

### Patch Changes

- Show more of the diff in the approval panel.

  The detail window was spending its rows on things that were not the diff. On a
  short terminal two of the four visible rows were `--- path` and `+++ path`,
  directly under a description line that already named the file, and most of the
  diff was cut.

  The path header is stripped at render, a diff is windowed around its first
  change rather than its first line — the context kept either side could otherwise
  push the change itself out of frame — and two blank rows that sat inside blocks
  are reclaimed. Anything that is not a diff still reads from the top, because in
  a shell command a leading `-` is a flag and the first word is what says what
  will run.

- Rotate the startup tagline, and open on a clean screen.

  Six taglines instead of one, picked once per session and shared by the animated
  banner and the static header that replaces it, so the sentence does not change
  as the reveal locks into place.

  Startup also clears the visible terminal, like Ctrl-L, so the shell prompt and
  whatever ran before it do not sit above the banner. Scrollback is kept, and
  nothing is emitted when stdout is not a TTY.

- Updated dependencies
  - @agentionai/marshall-engine@0.12.0

## 0.13.0

### Minor Changes

- a9c7bb7: Rename `/safety none` to `/safety yolo`.

  Level 1 removes the approval gate entirely, and `none` was the wrong word for
  that: in a list of `none | default | agentic` it reads as the neutral low end of
  a spectrum rather than as the setting that lets every tool call run unreviewed.
  `yolo` is not a joke — it is the point. A name you are slightly reluctant to type
  is doing useful work on the one mode that has no other guardrail, and the banner
  already shows it in red whenever the level is not the default.

  `/safety none` now returns the usage line naming the three current words. The
  level is session-only and never persisted, so nothing on disk or in a config
  needs migrating; only muscle memory.

### Patch Changes

- e1c2498: Keep the rendered frame inside the terminal, in both directions.

  Ink erases a frame by rewinding as many rows as its output has lines, which is
  only correct while the frame fits. Too tall and Ink clears the terminal —
  scrollback included — then reprints the whole static transcript on every render;
  with the activity spinner ticking at 80ms that was a dozen full-screen repaints a
  second, which read as flicker, unscrollable history and a frozen UI. Too wide and
  the terminal wraps a line the rewind never gets back, leaving the top row of the
  frame behind — one stale row per frame, which is the same answer printed over and
  over.

  So: the approval panel is budgeted against `stdout.rows` instead of a fixed
  twenty lines of detail and cuts each line to one row; the queue-a-prompt input
  steps aside on terminals too short to hold both; the spinner stops animating
  while the turn is blocked on you; and nothing renders into the terminal's last
  column. The width has to be applied to `<Static>`'s rows individually as well as
  to the root, because static items are laid out in their own pass and do not
  inherit it — unconstrained, a committed transcript row measured 121 columns wide
  in a 120-column terminal.

  Approvals need at least 20 rows to fit; below that the panel is degraded by
  design rather than silently oversized.

- Updated dependencies [a48a143]
  - @agentionai/marshall-engine@0.11.0

## 0.12.0

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

- 78df418: Complete slash command arguments, not just command names.

  Tab stopped working the moment you typed a space, so the argument words for
  `/model`, `/safety`, `/jobs` and `/mcp` were invisible unless you already knew
  them. `/model ` now offers `deep`, `/safety ag` finishes `agentic`, and verbs
  that still need a value (`/mcp remove`, `/jobs kill`) complete with a trailing
  space so the cursor lands where the name goes. The word list lives beside the
  parser and is tested against it, so completion cannot offer something the parser
  would reject.

  Also: a tagline under the wordmark, and safety verdict rows now stay on one line
  instead of wrapping and losing the gutter that marks them as commentary on the
  call above.

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
- Updated dependencies [78df418]
  - @agentionai/marshall-engine@0.10.0
  - @agentionai/marshall-tools@0.6.0

## 0.11.0

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
  - @agentionai/marshall-engine@0.9.0

## 0.10.0

### Minor Changes

- 958e40f: Add typeahead search to the model picker and include OpenRouter content-safety models, including free NVIDIA Nemotron guardrails, in the catalogue.

### Patch Changes

- Updated dependencies [958e40f]
  - @agentionai/marshall-engine@0.8.0

## 0.9.0

### Minor Changes

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

- 81cac61: Show the update notice in the session instead of after it.

  The startup check ran, found a newer release, and then printed it to stderr _after_ Ink had
  exited — into a terminal nobody is looking at any more. It now arrives as a transcript row
  that says what to do: `update available: 0.8.2 → 0.9.0 — type /update to install`.

  The row is held until the boot animation finishes, because the banner's `onDone` replaces
  the transcript wholesale; a row pushed while it was still animating was discarded. Since the
  check is a network round trip racing an animation, which one won was luck, and losing meant
  the notice silently never appeared.

  `checkForUpdate` now resolves to `{ current, latest }` rather than a pre-formatted string,
  so the two callers can each say the right thing — the startup row points at `/update`, while
  `/update` is already installing. When a global install fails (a root-owned prefix, usually)
  `/update` now hands over the `npm install -g` command instead of only reporting the error.

### Patch Changes

- 15a1b68: Stop a project-local `.marshall/config.json` from hiding stored API keys for providers it
  doesn't mention.

  `loadConfig` deep-merged the project config on top of the global one, and the generic merge
  replaces arrays wholesale — so a project pinning one provider (e.g. a `providers` entry for
  `llamacpp` left over from before credentials moved to the global config) silently discarded
  every other provider's entry from the merged view, including a stored API key. The `/model`
  wizard's key step then saw no stored key and correctly refused to advance on a bare enter,
  which looked like the enter key had stopped working. `providers` is now merged by provider
  name — a project can still override a provider it names, but no longer erases providers it
  doesn't mention.

- 81cac61: Show OpenRouter model pricing and capability metadata in the model picker.
- Updated dependencies [81cac61]
- Updated dependencies [81cac61]
- Updated dependencies [81cac61]
  - @agentionai/marshall-engine@0.7.0

## 0.8.2

### Patch Changes

- 4d3bd2b: Stop a project-local `.marshall/config.json` from hiding stored API keys for providers it
  doesn't mention.

  `loadConfig` deep-merged the project config on top of the global one, and the generic merge
  replaces arrays wholesale — so a project pinning one provider (e.g. a `providers` entry for
  `llamacpp` left over from before credentials moved to the global config) silently discarded
  every other provider's entry from the merged view, including a stored API key. The `/model`
  wizard's key step then saw no stored key and correctly refused to advance on a bare enter,
  which looked like the enter key had stopped working. `providers` is now merged by provider
  name — a project can still override a provider it names, but no longer erases providers it
  doesn't mention.

## 0.8.1

### Patch Changes

- 91a4334: Bump alongside `@agentionai/marshall-engine`'s fix for `/goal` getting stuck in a repeated
  tool-call loop on small local models — the CLI is where that loop was actually experienced, so
  its own version should reflect the fix too.

## 0.8.0

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
- Updated dependencies [6f94195]
- Updated dependencies [6f94195]
  - @agentionai/marshall-engine@0.6.0
  - @agentionai/marshall-tools@0.4.1

## 0.7.0

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
  - @agentionai/marshall-engine@0.5.0

## 0.6.1

### Patch Changes

- Add a package README (installation, providers, commands, keybindings, and global/project config) so it renders on the npm package page.

## 0.6.0

### Minor Changes

- Move credentials and provider/model settings to a global user config at `~/.config/marshall/config.json` (or `$XDG_CONFIG_HOME/marshall/config.json`), created on first run. An optional project-local `.marshall/config.json` is deep-merged on top so a repo can pin its own model/provider without touching global credentials — session logs and task notes stay project-local as before.

## 0.5.0

### Minor Changes

- feat: add @path file completion and inline expansion, formatToolName for readable tool labels, open weights site rebrand

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

### Patch Changes

- Ctrl- and alt- chords no longer type themselves into the prompt. Only ctrl-C was
  excluded before, so every other chord also inserted its letter — ctrl-R had been
  quietly appending an "r" each time it toggled reasoning.

  The startup output-token default no longer flattens the tiers. It was resolved
  once from the deep provider and applied to the whole session, so a local deep
  tier handed its 32768 to a hosted fast tier; the engine now resolves the cap per
  profile, as it was written to. Pass `--max-tokens` to set one deliberately.

  The setup wizard offers openrouter, llamacpp and ollama first — the providers
  whose model list it actually fetches from the server.

- Updated dependencies
- Updated dependencies
  - @agentionai/marshall-engine@0.4.0

## 0.3.0

### Minor Changes

- Rename from @marshall/_ to @agentionai/marshall-_

### Patch Changes

- Updated dependencies
  - @agentionai/marshall-engine@0.3.0
  - @agentionai/marshall-tools@0.3.0

## 0.2.0

### Minor Changes

- Initial release

### Patch Changes

- Updated dependencies
  - @agentionai/marshall-engine@0.2.0
  - @agentionai/marshall-tools@0.2.0
