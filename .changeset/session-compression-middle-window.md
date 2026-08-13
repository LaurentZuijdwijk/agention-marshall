---
"@agentionai/marshall-engine": patch
---

Narrow what compression folds instead of folding the whole overflow into one summary.

`middleCompressionPlugin` replaces the flat library summariser. It keeps the
first conversational turn and a short tail of the newest turns verbatim, and
summarises only a contiguous middle window that fits in bounded steps. When the
window already contains a prior summary, that summary is extended in place
(picking up its `coversRange`) rather than discarded and rebuilt. Reducing
stops as soon as a step makes no token progress, so the summariser never spins
re-emitting what is already there.

The result is smaller, cheaper summary prompts (each step folds ~3k tokens, well
under a local model's context window) and an older context that keeps more real
turns than a single all-or-nothing summary.