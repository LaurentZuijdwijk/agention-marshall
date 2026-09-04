---
"@agentionai/marshall-cli": patch
---

Run the rendering process with `NODE_ENV=production`, fixing a memory leak in long sessions.

With `NODE_ENV` unset — the default for every plain `marshall` invocation — Ink's
`react-reconciler` loads its development build, which marks and measures every render through
`perf_hooks` and never clears the buffer. A session that streams heavily for an hour crosses
Node's 1,000,000-entry threshold: confirmed live, a 1h41m session hit
`MaxPerformanceEntryBufferExceededWarning` at exactly 1,000,001 entries.

It cannot be set in the entry module itself. ESM import declarations are evaluated before any
other top-level code in the file, so an assignment above `import { render } from 'ink'` still runs
after Ink and the reconciler's dev/prod check have loaded. A child process's environment is fixed
before Node parses anything, so the existing `--max-old-space-size` respawn — which already
happens on essentially every launch — now carries `NODE_ENV` too. One respawn does both, and an
explicit `NODE_ENV` is never overridden, so a developer working on the TUI keeps the dev build's
warnings.
