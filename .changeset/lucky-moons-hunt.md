---
'@agentionai/marshall-tools': minor
'@agentionai/marshall-engine': minor
'@agentionai/marshall-cli': minor
---

Connect remote MCP servers over HTTP and use their tools.

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
