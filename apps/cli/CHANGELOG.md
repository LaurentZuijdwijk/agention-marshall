# @agentionai/marshall-cli

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
