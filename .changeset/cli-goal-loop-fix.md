---
'@agentionai/marshall-cli': patch
---

Bump alongside `@agentionai/marshall-engine`'s fix for `/goal` getting stuck in a repeated
tool-call loop on small local models — the CLI is where that loop was actually experienced, so
its own version should reflect the fix too.
