---
'@agentionai/marshall-engine': patch
'@agentionai/marshall-cli': patch
---

Recover from a full context window instead of failing the turn.

llama.cpp's small local context windows were surfacing raw 400s to the user, sometimes after a
multi-attempt retry storm that still failed. The token estimate used to size compression is
unreliable for code-heavy content, so guessing a fixed compression target or retrying blindly
wasted time and often failed anyway.

A context-length error now triggers one bounded compression pass — `reduceToTarget` walks down
in small steps so no single summarisation prompt can itself blow the same small context window
it's trying to recover from — sized to the actual measured overage in the provider's own error
rather than a flat percentage of the window. The task is then handed back to the user via the
existing steering-context mechanism (same as an Esc-interrupt) instead of auto-retrying, and the
CLI shows a plain "context window full" message instead of the raw provider error.

Also: the summariser agent's own history is now transient, so repeated compressions in one
session don't silently accumulate their own unbounded context; and provider error details
(status, response body) are now logged end-to-end for diagnosing recovery in production.
