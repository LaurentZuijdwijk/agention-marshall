---
"@agentionai/marshall-engine": patch
---

Fix a stale system message surviving a mid-session prompt change (`/runtime light`,
`/runtime agentic`, or any change to which tools are available) and ending up no longer first in
the request — several providers reject that outright (llama.cpp's Jinja chat template: "System
message must be at the beginning").

The SDK's own system-message guard only skips re-adding when the content is byte-identical to
what's already there; otherwise it appends a second entry rather than replacing the first, since
the underlying `History.addSystem` is a plain push. The session's History is shared and long-lived
— a fresh agent is constructed every turn against the same object — so a prompt that legitimately
differs from last turn's used to leave the old entry in place and land the new one wherever
history currently ended, after real user/assistant turns.

`Session` now keeps its own system entry first and current, using the exact content
`createAgent`'s own call is about to ask for (`agentSystemMessage`/`buildAgentDescription`, both
now exported from `agent-factory.ts` for this): a no-op when nothing changed, a clean
replace-and-reposition when it did.
