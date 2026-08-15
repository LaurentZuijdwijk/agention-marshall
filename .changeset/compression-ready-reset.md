---
"@agentionai/marshall-engine": patch
---

Stop a transient failure to build the summariser from disabling context compression for the
rest of the session.

`CompressionManager` set its `ready` flag before the summariser agent was actually built, so a
failure creating it (an unreachable model, say) left `ready` true with no working summariser
behind it — compression was then silently skipped for every later turn, even after a model
switch made the summariser reachable again. `ready` is now reset on that failure, so the next
attempt (the next turn, or `invalidateModel` after a switch) retries instead of short-circuiting
on the stale flag.
