---
"@agentionai/marshall-engine": minor
"@agentionai/marshall-cli": minor
---

Spawn background agents on `/runtime agentic`.

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