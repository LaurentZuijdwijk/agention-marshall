---
"@agentionai/marshall-tools": patch
---

Trim `list_dir` and `search`'s tool descriptions — wording only, no behavior change. Cuts about
56 tokens of fixed per-turn overhead while keeping the parts proven this cycle to prevent real
failures: the case-sensitivity flip between plain-name and regex search, and `fileGlob` being a
name filter rather than a path.
