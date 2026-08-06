---
'@agentionai/marshall-engine': minor
---

Add a fake OpenAI-compatible model server, exported as `@agentionai/marshall-engine/testing`.

Every test so far stopped at the edge of the provider, so nothing covered the loop that
actually breaks: a tool call reaching a tool, the approval gate sitting between the two, a
job exiting and waking the agent. `startFakeProvider` serves `/v1/chat/completions` in both
shapes the engine uses — SSE for `run()`, one JSON body for `/plan` and `/review` — from a
scripted list of turns, and records what the model was sent. A test points an
`AgentProfile.host` at it and everything below stays real: the `openai` SDK, the tool-call
loop, the tool belt, the event stream.

New integration suites cover a gated `write_file` end to end, the denial path, an
interrupted turn, and a background job auto-resuming a turn on its own.
