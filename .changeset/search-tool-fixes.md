---
'@agentionai/marshall-tools': patch
---

Fix the `search` tool's file matching, single-file targets, and invalid regexes.

`fileGlob` matched anywhere in the full path, so a glob meant to filter by extension also
matched directory names containing the same text; it now matches the basename only. `search`
also rejected a direct file path (it only ever walked directories), threw uncaught on an invalid
regex instead of returning an error, and had an off-by-one in its truncation flag. Per-file reads
during a search are now capped so one huge file can't blow the budget.
