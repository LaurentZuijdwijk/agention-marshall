---
"@agentionai/marshall-cli": patch
"@agentionai/marshall-engine": patch
"@agentionai/marshall-tools": patch
---

Update `@agentionai/agents` to 1.16.0, which sends string tool results to the model as plain text instead of a JSON string literal. File contents, shell output and logs previously arrived quoted with escaped newlines, which local models in particular read poorly.
