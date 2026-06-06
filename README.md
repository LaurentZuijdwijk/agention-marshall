# agention-marshall

A terminal-based coding assistant built on [Agention](https://docs.agention.ai) and Claude. Takes natural-language tasks and uses a multi-agent planner/coder/reviewer loop to read, edit, and run code inside your project — with human-in-the-loop approval for every state-changing action.

## Structure

```
apps/cli          — REPL client (thin client of the engine)
packages/engine   — Headless session engine (no I/O; transport-agnostic)
packages/tools    — Reusable, safe-by-default tool belt
```

## Prerequisites

- Node 20+
- `ANTHROPIC_API_KEY` in your environment

## Setup

```bash
npm install
export ANTHROPIC_API_KEY=sk-...
```

## Run

```bash
npm run cli -- --workspace /path/to/your/project
```

## How it works

### Multi-agent loop

1. **Planner** — turns your task into an ordered, concrete plan
2. **Coder** — executes plan steps using the tool belt
3. **Reviewer** — inspects diffs and results; loops with the coder up to a configurable max

### Tools

All tools live in `packages/tools` and are safe-by-default:

| Tool | Approval required |
|---|---|
| `read_file` | No |
| `list_dir` | No |
| `search` | No |
| `write_file` | Yes |
| `edit_file` | Yes |
| `run_shell` | Yes |

Before any state-changing tool runs, the proposed action (diff, command, path) is shown and you choose: **approve / deny / always-allow-this-session**.

### Sandbox

File tools are hard-jailed to `WORKSPACE_ROOT`:
- All paths are normalized and resolved; `..` traversal and symlinks that escape the root are rejected.
- Reads and writes enforce max file/output size limits.

Shell commands run with:
- `cwd = WORKSPACE_ROOT`
- Scrubbed environment (allowlisted vars only)
- Configurable timeout + process-group kill
- stdout/stderr size caps
- Configurable command policy (allowlist/denylist patterns)

> **Sandbox limits:** this is a *containment* boundary for file tools and a *policy* boundary for shell — not a hard security boundary. A shell command can still reach the network or read files outside the workspace via absolute paths. True OS-level isolation (Docker/microVM) is a planned upgrade; the tool interface will not need to change — only the executor behind it.

### Interruptions

Press **Esc / Ctrl-C** to interrupt the current task:
- Stops at the next safe boundary
- Kills any running shell process immediately (process group)
- Never leaves a half-written file (atomic writes: temp file + rename)
- Drops into **steer mode** — type a new instruction and the loop course-corrects without restarting
- A second Esc/Ctrl-C hard-cancels

### Memory

**Session (working memory):**
- Shared persistent history across all agents in a session
- Tool-result masking (recent results kept in full; older ones masked but retrievable)
- Rolling compression past a token threshold
- Load-bearing items (active plan, task goal) are pinned so compression can't drop them
- Read deduplication — re-reading an unchanged file does not re-flood the context

**Long-term (project memory):**
- A `MARSHALL.md` file in your workspace holds conventions, architecture notes, and prior decisions
- Loaded into the system prompt at session start
- The agent can propose updates to it (behind approval, since it's a file write)

## CLI commands

| Command | Description |
|---|---|
| `/help` | Show available commands |
| `/exit` | Exit the REPL |
| `/clear` | Reset session history |
| `/cwd` | Show current workspace root |
| `/auto` | Toggle auto-approve for read-only or a named tool |
| `/memory` | View/edit project memory |
| `/model` | View or switch the model for a given role (planner/coder/reviewer) |

## Config

All config via environment or a config file. Sensible defaults ship out of the box — only `ANTHROPIC_API_KEY` and a workspace path are required.

| Setting | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Required |
| `WORKSPACE_ROOT` | Root directory the agent can touch (default: cwd) |
| Model per role | Planner, coder, reviewer each configurable |
| Approval defaults | Per-tool approval policy |
| Shell command policy | Allowlist/denylist patterns |
| Timeouts & size caps | Per-tool limits |
| Max reviewer iterations | Prevents infinite loops |

## IDE integration

A reference VS Code extension is planned (milestone 6). The engine exposes a **stdio JSON-RPC** transport; the extension spawns it in headless mode and:
- Feeds open files, selection, cursor, and diagnostics into the engine
- Renders proposed edits in the editor's native diff view
- Routes approval prompts to an editor modal
- Streams agent output into an editor panel

No `vscode` import ever touches the engine.

## Development

```bash
npm test          # run all workspace tests
```

## Out of scope

True OS-level isolation, network egress control, multi-repo workspaces, editors beyond the reference VS Code extension, exposing this assistant *as* an MCP server, and non-Claude providers (the config seam is there; swap-in is future work).
