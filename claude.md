# Build prompt: a CLI coding assistant on Agention

## Mission

Build a terminal-based coding assistant (Claude Code–style) in TypeScript, using the **Agention** library (`@agentionai/agents`) for agent orchestration. It runs in a REPL, takes natural-language tasks, and uses tools to read, edit, and run code inside the user's project — with a multi-agent planner/coder/reviewer loop, human-in-the-loop approval for any state-changing tool, and a sandbox that confines file and command operations to a workspace directory.

---

## CRITICAL: read the docs first, do not guess the API

Agention is very likely **not in your training data**. Do **not** invent method names, options, or imports. Before writing any code that touches the library, fetch and read these pages, and keep verifying signatures against them as you go:

- https://docs.agention.ai/guide/getting-started.html
- https://docs.agention.ai/guide/quickstart.html
- https://docs.agention.ai/guide/agents.html
- https://docs.agention.ai/guide/tools.html
- https://docs.agention.ai/guide/history.html
- https://docs.agention.ai/guide/context-management.html
- https://docs.agention.ai/guide/graph-pipelines.html
- https://docs.agention.ai/guide/mcp.html
- https://docs.agention.ai/api/

If a needed capability isn't documented, treat it as **not existing** and build it yourself in our own code rather than assuming the library provides it. Call out any such gaps in comments and in the final summary.

---

## Tech stack

- TypeScript, Node 20+, ESM.
- Monorepo (npm/pnpm workspaces): at least `packages/tools` (reusable, safe-by-default tools) and `packages/engine`/`apps/cli` for the assistant. The IDE extension is a separate workspace package later.
- `@agentionai/agents` + `@anthropic-ai/sdk` (Claude as the default provider; keep provider choice in config so it can be swapped).
- A small CLI/REPL (use a lightweight readline or `ink`/`@clack/prompts`-style approach — your call, keep deps minimal).
- API keys from environment only (`ANTHROPIC_API_KEY`); never hard-code or log secrets.

---

## Architecture

**Core engine vs. clients (do this first — everything else depends on it).** The REPL must **not** be the application. Build a headless **session engine** (no I/O of its own) that exposes a small, transport-agnostic protocol, and make the CLI one client of it. A VS Code extension will be a second client (see IDE integration). Everything the engine needs from the outside world is injected through a **client interface**:

- `onOutput(event)` — stream tokens, agent-switch notices, tool calls/results, diffs.
- `requestApproval(action) → Promise<decision>` — the approval gate from before, now client-routed (terminal prompt, or an editor modal).
- `getEditorContext?() → context` — optional: open files, selection, cursor, diagnostics (CLI returns nothing; IDE returns real data).
- An **interrupt channel** the client can signal at any time (see Interruptions).

Pick a concrete transport for remote clients — **stdio JSON-RPC** is recommended (portable, what editor extensions spawn easily, same family as MCP). The in-process CLI can call the engine directly; the IDE client goes over the transport. Keep the protocol documented in one place.

**Multi-agent loop** using Agention's "agents as tools" / pipeline primitives (verify exact API in the docs — likely `agents: [...]`, `Tool.fromAgent`, `Pipeline`, `AgentGraph`):

- **Planner** — turns a task into an ordered, concrete plan (files to touch, steps, checks). Cheaper/faster model is fine.
- **Coder** — executes plan steps using the tool belt (read/edit/run). Strongest model.
- **Reviewer** — inspects the coder's diffs and command results, decides done / needs-revision, and reports back. Can loop with the coder up to a configurable max iteration count.

Orchestrate these explicitly so the flow is visible (no hidden state). Surface which agent is active in the CLI output.

**Shared, persistent history** across the agents for one session, with the context-management plugins enabled (see History below).

---

## Tools (a reusable `packages/tools` workspace)

Put the tools in their own internal package (`packages/tools` in the monorepo), **not** inline in the engine. The point of the package is not the actions themselves (a `fs.writeFile` wrapper is trivial) — it's **safe-by-default action tools**: the path jail, approval gating, atomic writes, output caps, and abort-aware spawning, packaged so the CLI and the IDE extension share one audited implementation. Note that Agention's own docs ship unsafe defaults (e.g. `eval()` with a "use a safe parser in production" note), so do **not** expose raw tools — safety is the product here.

Build it in three layers, bottom-up:

1. **Safety primitives** (no Agention dependency): `resolveInWorkspace(root, p)` (normalize, reject `..`, reject absolute-outside-root, resolve symlinks and re-check), `atomicWrite` (temp file + rename), `cappedRead`/output truncation, and `spawnSandboxed` (scrubbed env, `cwd`, timeout + process-group kill, accepts an `AbortSignal`, output caps).
2. **Tool factories** (depend only on `@agentionai/agents`): functions like `createFileTools(config)`, `createShellTool(config)` that take **injected config** — `{ workspaceRoot, approval, signal, commandPolicy, limits }` — and return Agention `Tool` instances built on the primitives. Safety is contextual, so it is configured in, never hard-coded. A `withApproval(tool, policy)` decorator lives here too.
3. **App wiring** (in the engine, not the package): the coding assistant constructs the config — real `WORKSPACE_ROOT`, the client-routed `approval`, the task's `AbortSignal`, its command policy — and calls the factories.

**Dependency rule:** `packages/tools` may import `@agentionai/agents` and Node built-ins only. It must **never** import the engine, the CLI, or `vscode`. That boundary is what lets a second consumer reuse it unchanged.

The tools to provide:

Read-only (the factory marks these no-approval):
- `read_file`, `list_dir`, `search` (grep/ripgrep-style) — all within the workspace.

State-changing (factory wraps these in `withApproval`):
- `write_file` (atomic), `edit_file` (prefer find/replace or patch over full rewrites; produce a diff), `run_shell` (via `spawnSandboxed`).
- (optional) `delete_path`, `git` (status/diff/commit), `apply_patch`.

Tool rules:
- `execute` returns a **string** and **never throws** — catch errors and return them as readable strings so the agent can react.
- Keep tools focused and descriptions LLM-facing and precise.
- Use Agention tool events (`ToolEvent.EXECUTE`, `ToolResultEvent.RESULT` — verify names) for **logging/observability only**, not for the approval gate (see why below).
- Existing MCP tool servers (filesystem, git) are **not** a substitute here: they bring weaker scoping and can't route through our `approval`/`signal`. Treat MCP as an optional *extra* tool source, not the path/shell layer.

---

## Sandbox (containment, honestly scoped)

Isolation strategy: **local subprocess + a locked-down workspace directory**. This is enforced by the **safety primitives in `packages/tools`** (`resolveInWorkspace`, `spawnSandboxed`); the engine just supplies config. Be explicit in code comments and the README that this is a **containment** boundary for the file tools and a **policy** boundary for shell — **not** a hard security boundary against malicious code. A shell command can still touch the network or read files outside the workspace via absolute paths. Design accordingly:

File tools (hard jail):
- Resolve every path against a single `WORKSPACE_ROOT`. Reject anything that escapes it: normalize, reject `..` traversal, reject absolute paths outside root, and **resolve symlinks** and re-check the real path is still inside root.
- Enforce a max file size for reads/writes and a max output size returned to the model (truncate with a clear marker).

Shell tool (policy + limits):
- Run via `child_process` with `cwd = WORKSPACE_ROOT`, a **scrubbed env** (only an allowlist of vars), a **timeout** that kills the process group, and stdout/stderr size caps.
- Apply a configurable command policy: an allowlist or a denylist of dangerous patterns (e.g. `rm -rf /`, `curl | sh`, package publishes). Block or force-approve on match.
- Document that true network/process isolation is out of scope for this mode and note the clean upgrade path to Docker/microVM later (the tool interface should not need to change — only the executor behind it).

---

## Human-in-the-loop approval

Goal: every state-changing tool call pauses and asks the user in the terminal before it runs, showing exactly what will happen (path + diff for edits, full command for shell). Approve / deny / always-allow-this-tool-this-session.

**Implementation — important:** do **not** rely on a tool `EXECUTE` event + `preventDefault()` for the gate. Verify in the docs whether event listeners are awaited; EventEmitter listeners typically are **not**, so an async "wait for the human" listener may not actually block execution. Instead, implement approval as a **wrapper around the tool's `execute`**:

- Write a higher-order function `withApproval(tool, policy)` that returns a new `Tool` whose `execute` first `await`s an approval decision (rendering the proposed action), and only calls the original `execute` on approval; on denial it returns a clear string telling the agent the action was rejected and not to retry identically.
- Drive the approval policy from a table: read-only tools → auto-approve; write/edit/shell/delete → require approval; honor session-level "always allow".
- Make approval injectable (a function/callback) so it can be unit-tested without a real TTY and later swapped for non-interactive/auto-approve CI modes.

---

## IDE integration

Goal: parity with Claude Code / Cursor–style editor integration. The library gives us nothing here (Agention's MCP support is client-side only — for *consuming* external tool servers, not for being attached to). So we build it on the core-engine seam above.

Ship a **reference VS Code extension** (thin client) and design the engine so other editors can attach later:

- The extension spawns the engine in headless mode and talks **stdio JSON-RPC** to it (the protocol from Architecture).
- **Editor → engine context:** open files, current selection, cursor position, and diagnostics flow in via `getEditorContext()`, so the agents can act on "this file"/"this selection" without the user pasting paths.
- **Engine → editor actions:** render proposed edits in the editor's **native diff view**, route the approval prompt to an editor modal/CodeLens (reusing `requestApproval`), and apply accepted edits through the editor's workspace-edit API so undo history is preserved.
- Stream agent output and tool activity into an editor panel.
- Keep editor-specific code **only** in the extension; the engine stays editor-agnostic and never imports `vscode`.

Separately (and don't conflate with the above): the assistant may **consume** existing MCP servers (filesystem, git, GitHub) as extra tools via Agention's `MCPClient` (`fromStdio`/`fromUrl`, `connect()`, `getTools()`, `addTools()` — verify in the MCP docs). Treat that as an optional tool source, gated by the same approval/sandbox rules, not as the IDE mechanism.

## Interruptions & cancellation

The user must be able to stop the agent mid-task (Esc/Ctrl-C in the CLI, a stop button in the editor) and ideally **steer** rather than only abort.

- Thread an `AbortSignal` (one `AbortController` per task) through the whole engine: agent execution, tool execution, and child processes. **Verify whether Agention's `execute()` accepts a cancellation signal / abort option** — if it does, pass it; if not, build cancellation at the boundaries we control.
- Be honest about reach: an in-flight LLM request can only be aborted if the library/provider exposes a signal (the Anthropic SDK supports `AbortSignal`). Where it doesn't, interrupt at the **next safe boundary** — between agent turns and before/after each tool call.
- A running `run_shell` process must be killed **immediately** on interrupt (kill the process group — reuse the timeout-kill path).
- **Steering:** after an interrupt, let the user type a new instruction that is appended to the shared history so the loop course-corrects on the next turn instead of restarting from scratch. Make this the default UX, not a hard cancel.
- Leave state consistent on interrupt: never leave a half-written file (write atomically — temp file + rename), and report to the agent/history that the task was interrupted.

## Memory & history optimization

Treat this as **two distinct layers** — don't collapse them:

**Working memory (current session context).**
- Persistent shared `History` for the session (file-backed is fine; verify class name/constructor in the docs).
- Context plugins on, so the window stays lean automatically: tool-result **masking** (keep the most recent N results in full; verify the masking plugin also exposes a *retrieve* tool so the agent can pull a masked result back on demand) and rolling **compression/summarization** via a cheap summary agent past a token threshold. Verify `toolResultMaskingPlugin`, `compressionPlugin`, `.use(...)` signatures against the docs.
- **Pin** load-bearing items so compression can't drop them: the active plan, key file summaries, the task goal.
- **Dedupe** repeated reads — don't let the same file get read into context five times; cache by path+hash and return a "unchanged since last read" marker.
- This matters more here than in most apps: file reads and command output flood the window fast.

**Long-term project memory (across sessions).**
- A persistent, human-editable project memory file (a `CLAUDE.md`/`AGENTS.md`-style doc in the workspace) holding conventions, architecture notes, and prior decisions. Load it into the system prompt at session start; let the agent propose updates to it (behind approval, since it's a file write).
- Optionally index the repo into Agention's vector store (LanceDB) for semantic code retrieval as a memory tool — verify the RAG/vector-store API in the docs. Mark this **optional / later** to control scope.

---

## CLI / UX

- The CLI is a **client of the engine** (Architecture), not the engine itself. REPL: prompt for a task, stream progress, show which agent is acting.
- Render diffs before any `write_file`/`edit_file` and the full command before any `run_shell`, then the approval prompt (via `requestApproval`).
- Slash commands: at minimum `/help`, `/exit`, `/clear` (reset history), `/cwd` (show workspace), `/auto` (toggle auto-approve for read-only or a named tool), `/memory` (view/edit project memory). Keep it extensible.
- Esc / Ctrl-C interrupts the current task and drops into steering (type a new instruction) rather than crashing; a second Esc/Ctrl-C hard-cancels. Tool errors are surfaced and the loop continues.

---

## Observability

- Use Agention's metrics/token tracking (verify: `MetricsCollector`, `agent.lastTokenUsage`) to print per-task token + timing summaries.
- Log every tool call (tool name, agent, input, approved/denied, result size) to a session log file.

---

## Config

- A single config (file or env) for: model per role (planner/coder/reviewer), provider, `WORKSPACE_ROOT`, approval defaults, shell command policy, timeouts, size caps, max reviewer iterations.
- Sensible defaults so it runs with just `ANTHROPIC_API_KEY` set and a workspace path.

---

## Build in milestones (ship each, verify, then continue)

1. **Scaffold + headless engine + CLI client + read-only tools.** Project setup, config, the engine/client seam, and a single ClaudeAgent that can `read_file`/`list_dir`/`search` in the workspace. Prove the loop works end to end through the client interface (not a hard-wired REPL).
2. **`packages/tools` + state-changing tools behind approval.** Build the three-layer tools package (safety primitives → factories → wiring): path jail, `spawnSandboxed`, atomic writes, the `withApproval` decorator, diff/command rendering, the approval policy table — approval routed through the client. Tools take injected config only.
3. **Memory & history.** Shared persistent history + masking/compression plugins + pinning + read dedupe; the long-term project-memory file loaded at startup.
4. **Multi-agent loop.** Planner → coder → reviewer orchestration with the reviewer/coder revision loop and a max-iteration cap.
5. **Interruptions & cancellation.** `AbortSignal` threaded through engine/agents/tools, immediate shell kill, atomic writes, and post-interrupt steering.
6. **IDE integration.** Reference VS Code extension over stdio JSON-RPC: editor context in, native diffs + approval modal out, output panel.
7. **Polish.** Slash commands, metrics summary, session logging, optional MCP/vector-store tool sources, README, tests.

---

## Acceptance criteria (definition of done)

- Runs from the terminal with only `ANTHROPIC_API_KEY` and a workspace path; completes a small real task (e.g. "add a function and a passing test") end to end.
- `packages/tools` depends only on `@agentionai/agents` and Node built-ins — no import of the engine, CLI, or `vscode` (enforce with a lint rule or dependency check). Its tools take safety config purely by injection.
- The engine has **no direct I/O** — the CLI works purely through the client interface, proven by the fact that the VS Code extension drives the same engine with no engine changes.
- No file tool can read or write outside `WORKSPACE_ROOT`, including via `..` or a symlink (cover this with a test).
- No `write_file`/`edit_file`/`run_shell` ever executes without an explicit approval (or a session "always allow"); denial is reported back to the agent and it does not blindly retry. Covered by tests using an injected approval function.
- Shell commands run with a timeout, scrubbed env, output caps, and the command policy applied.
- Interrupting a task stops work at the next safe boundary, kills any running shell process immediately, never leaves a half-written file, and lets the user steer with a new instruction that the loop picks up.
- Context plugins are active and load-bearing items are pinned; a long session does not blow the context window, and re-reading an unchanged file does not re-flood it.
- Long-term project memory is loaded at startup and the agent can propose updates to it (behind approval).
- The VS Code extension attaches over stdio JSON-RPC, feeds editor context in, and renders diffs + approvals in-editor; no `vscode` import leaks into the engine.
- Every Agention API used is confirmed present in the docs; any assumed-but-missing capability (e.g. a cancellation signal on `execute()`) is implemented in our code and called out.
- README documents setup, the approval model, the interrupt/steer model, and — explicitly — the sandbox's limits and the Docker/microVM upgrade path.

---

## Out of scope (note as future work)

- True OS-level isolation (containers/microVM), network egress control, multi-repo workspaces, editors beyond the reference VS Code extension, exposing our assistant *as* an MCP server, **publishing `packages/tools` as a public npm package** (keep it internal until the API proves itself), and non-Claude providers beyond the swappable config seam. (Consuming external MCP servers as a tool source is in scope but optional — milestone 7.)

When done, summarize: what was built per milestone, every Agention API you verified vs. anything you had to build yourself, and the known limitations of the sandbox.
