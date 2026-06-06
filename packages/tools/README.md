# @marshall/tools

Reusable, safe-by-default tool implementations for the Marshall coding assistant. Provides Agention `Tool` instances for file operations, shell execution, a private scratch area, and GitHub — all scoped to a workspace directory with a human-in-the-loop approval gate on every state-changing action.

**Dependency rule:** this package imports only `@agentionai/agents` and Node built-ins. It never imports the engine, CLI, or `vscode`. That boundary is what lets a second consumer (e.g. a VS Code extension) reuse it unchanged.

---

## Structure

```
src/
├── types.ts               ToolConfig, ApprovalFn, Limits, CommandPolicy, ToolSpec
├── primitives/            Safety building blocks — no Agention dependency
│   ├── resolve.ts         resolveInWorkspace: path jail + symlink check
│   ├── atomic-write.ts    atomicWrite: temp-file + rename
│   ├── capped-read.ts     cappedRead: size-capped file reads
│   └── spawn.ts           spawnSandboxed: scrubbed env, timeout, process-group kill
└── factories/             Agention Tool instances built on the primitives
    ├── approval.ts        withApproval: wraps any ToolSpec with an awaited approval gate
    ├── file-tools.ts      createFileTools → read_file, list_dir, search, write_file, edit_file
    ├── shell-tool.ts      createShellTool → run_shell
    ├── scratch-tools.ts   createScratchTools → note_write/read/list, log_append/read
    └── github-tools.ts    createGitHubTools → gh_list_issues, gh_view_issue, gh_list_prs,
                                               gh_view_pr, gh_diff, gh_create_pr, gh_comment
```

---

## Config

Every factory takes a `ToolConfig` — the engine constructs it and injects real values; the tools themselves never read env vars or hard-code paths.

```ts
interface ToolConfig {
  workspaceRoot: string;       // all file paths are jailed here
  approval: ApprovalFn;        // (request) => Promise<'approve' | 'deny' | 'always'>
  signal?: AbortSignal;        // threads through to shell processes
  commandPolicy?: CommandPolicy;
  limits?: Limits;
}

interface Limits {
  maxFileBytes?: number;       // default 256 KiB
  maxOutputBytes?: number;     // default 64 KiB per shell stream
  timeoutMs?: number;          // default 30 s
  maxSearchResults?: number;   // default 200
}

type CommandPolicy =
  | { mode: 'allowlist'; patterns: RegExp[] }
  | { mode: 'denylist';  patterns: RegExp[] }
  | { mode: 'none' };
```

---

## Tools

### File tools — `createFileTools(config)`

| Tool | Approval | Description |
|------|----------|-------------|
| `read_file` | no | Read a file with line numbers. Supports `startLine`/`endLine` for large files. |
| `list_dir` | no | List files and directories (non-recursive). |
| `search` | no | Regex search across files. Returns `file:line: content`. |
| `write_file` | **yes** | Atomic write (temp + rename). File must be read first if it already exists. |
| `edit_file` | **yes** | Find-and-replace (oldString must appear exactly once). File must be read first. |

**Write guard:** `write_file` and `edit_file` reject writes to existing files that haven't been read in the current session. This prevents blind overwrites.

**`read_file` output format:**
```
# src/index.ts  (lines 1–42 of 42)
 1 | import React from 'react'
 2 |
...
```

### Shell tool — `createShellTool(config)`

| Tool | Approval | Description |
|------|----------|-------------|
| `run_shell` | **yes** | Run a command via `sh -c` inside `workspaceRoot`. |

Sandbox properties:
- `cwd` locked to `workspaceRoot`
- Environment scrubbed to an allowlist (PATH, HOME, USER, LANG, git/gh vars)
- Killed (process group) on timeout or `AbortSignal`
- stdout/stderr capped at `maxOutputBytes`
- Command checked against `commandPolicy` before execution

Default denylist blocks: `rm -rf /`, `curl|sh`, `wget|sh`, `npm publish`, `git push --force`, `dd if=`, `mkfs`, `shutdown/reboot/halt`.

### Scratch tools — `createScratchTools(config)`

No approval required — these write to `.marshall/` inside the workspace, which is the agent's private space.

| Tool | Description |
|------|-------------|
| `note_write` | Write/update a named markdown note in `.marshall/notes/`. |
| `note_read` | Read a note by name. |
| `note_list` | List all saved notes. |
| `log_append` | Append a timestamped entry to `.marshall/session.log`. |
| `log_read` | Read the session log (optional `tail: N` for last N lines). |

### GitHub tools — `createGitHubTools(config)`

Uses the `gh` CLI (must be installed and authenticated). All calls go through `spawnSandboxed`.

| Tool | Approval | Description |
|------|----------|-------------|
| `gh_list_issues` | no | List issues (`state`, `label`, `limit`). |
| `gh_view_issue` | no | View issue body and comments. |
| `gh_list_prs` | no | List pull requests (`state`, `limit`). |
| `gh_view_pr` | no | View PR description and review comments. |
| `gh_diff` | no | Show PR diff. |
| `gh_create_pr` | **yes** | Create a PR (`title`, `body`, `base`, `draft`). |
| `gh_comment` | **yes** | Post a comment on an issue or PR. |

---

## Approval gate

`withApproval(spec, approvalFn, buildRequest)` wraps any `ToolSpec` and returns a `Tool` whose `execute` awaits the approval function before proceeding.

```ts
// Injected by the engine — no TTY dependency in this package
const approval: ApprovalFn = (request) => client.requestApproval(request);
```

On denial the agent receives: `Action denied by user. Tool "X" was not executed. Do not retry this exact action without rephrasing your approach.`

The approval function is injectable so tools can be unit-tested without a real TTY:

```ts
const autoApprove: ApprovalFn = async () => 'approve';
const tools = createFileTools({ workspaceRoot, approval: autoApprove });
```

---

## Safety scope

The path jail and sandboxed spawn are **containment** boundaries, not hard security boundaries:

- File tools **cannot** read or write outside `workspaceRoot`, including via `..` traversal or symlinks that resolve outside the root.
- Shell commands **can** still reach the network or absolute paths outside the workspace — the sandbox is a policy boundary, not OS-level isolation.
- True network/process isolation (Docker, microVM) is out of scope but the tool interface is designed so only the executor behind `spawnSandboxed` needs to change to support it.
