---
"@agentionai/marshall-tools": patch
"@agentionai/marshall-engine": patch
---

Fix four ways the workspace `search` tool put wrong or wasteful content into an agent's context.

The truncation notice `cappedRead` appends was being scanned as if it were a line of the file, so
searching for a word in it reported a match at a line number the file does not have. Binary files
are now skipped the way grep skips them, instead of decoding to replacement characters and
matching. A single hit in a minified or bundled file returned the whole line — up to 256 KiB for
one match — and is now clipped to a window centred on the match. Generated output directories
(`target`, `out`, `vendor`, `.gradle`, `Pods`, `.terraform` and others) are skipped alongside the
ones already listed — and that skip list is now applied only to directories, so an ordinary file
that happens to be named `build` or `vendor` is searched instead of silently passed over.

`search` also now says when a file was only read up to its per-file cap, and when binaries were
skipped — including on a "no matches" result, where "nothing found" in a partly-read file is a
weaker claim than it looks.

A sub-agent that fails to construct (`context`, `search`, `planner`, `reviewer`) now logs
`SUBAGENT_UNAVAILABLE` with the provider error instead of disappearing from every turn silently.
