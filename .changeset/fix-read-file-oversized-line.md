---
"@agentionai/marshall-tools": patch
---

Fix `read_file` sending a whole file over `maxFileBytes` in a single request when the file's
first (or `startLine`-targeted) line is itself larger than the cap — a minified bundle or a
one-line JSON dump, for example.

The line-window reader always included a window's first line in full, on the reasoning that a
window rendering nothing tells the model nothing. That had no upper bound of its own: a 480 KB
single-line file bypassed `maxFileBytes` entirely and went out uncapped, which is what turned a
routine tool call into a request large enough for a provider to reject as exceeding its context
window. The oversized line is now clipped to fit the cap instead, and `read_file`'s truncation
notice says so specifically — "this line exceeds the read limit on its own" rather than the
generic "read another section," which was never the fix for a single huge line.
