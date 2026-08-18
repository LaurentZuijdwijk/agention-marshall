---
"@agentionai/marshall-engine": minor
"@agentionai/marshall-tools": minor
---

Add `list_conflicts` and `resolve_conflict` tools for resolving git merge, rebase, and cherry-pick conflicts. `list_conflicts` reports each unresolved hunk with a short content-hashed id, its line range, ours/theirs labels and commit ids, and a few lines of surrounding context — without needing the whole file in context. `resolve_conflict` takes that id back with `ours`, `theirs`, or `both` and applies it directly, gated behind the normal approval flow.
