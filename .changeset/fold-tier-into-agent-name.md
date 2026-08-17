---
'@agentionai/marshall-engine': minor
---

`spawn_agent`'s `tier` argument is gone; delegating to the fast tier is now
`agent_name: "fast"`, the same field used for a saved named agent. Previously
`tier` (`fast`/`deep`) and `agent_name` were separate, mutually-exclusive
arguments — a model could still ask for a bare `deep`-tier spawn. That option
is removed: an ad-hoc spawn is now always `"fast"` or a configured named
agent, matching the guidance that delegated work should either be mechanical
(fast) or handed to a persona built for it.
