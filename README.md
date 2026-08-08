# agention-marshall

A terminal-based coding assistant built on [Agention](https://docs.agention.ai). Takes natural-language tasks and uses a multi-agent planner/coder/reviewer loop to read, edit, and run code inside your project — with human-in-the-loop approval for every state-changing action.

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
| `shell_output` | No |
| `shell_kill` | No |
| `shell_list` | No |

Before any state-changing tool runs, the proposed action (diff, command, path) is shown and you choose: **approve / deny / always-allow-this-session**.

### Background commands

`run_shell` takes a `background` option for anything long-running — a test suite, a build, a dev server, a watcher. It returns a job id immediately instead of blocking the turn, and the agent carries on with work that doesn't depend on the result.

When the command finishes, its result is fed back into the conversation. If nothing is running at that moment, **the agent picks the work back up on its own** — so "run the suite, fix what breaks" is one instruction rather than a babysitting session. A turn started this way is marked in the transcript, and there is a cap (default 4) on how many turns may run unattended before you have to say something; set `autoResume: false` to have results simply wait for your next message instead.

Background jobs deliberately survive **Esc** — that is what backgrounding means. Use `/jobs` to see what is running, `/jobs kill <id>` (or `kill all`) to stop it. `/clear` and quitting stop everything.

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
- Kills any running foreground shell process immediately (process group); background jobs keep running by design — stop those with `/jobs kill`
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
- An `AGENTS.md` file in your workspace holds conventions, architecture notes, and prior decisions
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

## Release process

Releases use [Changesets](https://github.com/changesets/changesets). Keep release credentials out of the repository; authenticate with npm locally or through the release environment.

### Contributors

For a user-facing change, add a changeset before opening the PR:

```bash
npm exec changeset
```

Select the affected package(s), choose the appropriate semver bump, and write a concise release note. Commit the generated file under `.changeset/` with the change. Documentation-only or internal changes do not need a changeset.

### Maintainers

From a clean checkout of `main`:

```bash
npm ci
npm test
npm run typecheck -w @agentionai/marshall-cli  # optional focused check
npm exec changeset status
npm exec changeset version
npm install                    # refresh package-lock.json
npm test
```

Review the generated package versions, changelogs, and lockfile. Then commit the release changes and push them to `main`:

```bash
git add .changeset apps packages package-lock.json
git commit -m "chore: release"
git push origin main
```

After the release commit is pushed, authenticate to npm and publish all versioned workspaces:

```bash
npm whoami
npm exec changeset publish
```

`changeset publish` builds packages through their `prepare` scripts, publishes the changed packages, and creates git tags. Push those tags if they were not pushed automatically:

```bash
git push --follow-tags origin main
```

Verify the published package versions on npm and smoke-test the CLI after publishing. If publishing is interrupted, inspect `npm exec changeset status` and rerun the publish command; do not create a second version commit unless the first publish completed and the repository state requires it.

## Out of scope

True OS-level isolation, network egress control, multi-repo workspaces, editors beyond the reference VS Code extension, and exposing this assistant *as* an MCP server.
