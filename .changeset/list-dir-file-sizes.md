---
"@agentionai/marshall-tools": patch
---

`list_dir` now reports each file's size in bytes.

Without it, a model choosing between `read_file` and `search` for a large single-line file (a
minified bundle, say) had no way to know the file was large until after calling `read_file` on
it — which, even correctly capped, can still mean tens of thousands of tokens of repeated content
for a question `search` would have answered in a few hundred. Seeing the size up front is what
lets a model prefer `search` for a file it can tell in advance is not meant to be read whole.

Sizes are column-aligned without spreading one argument per entry into `Math.max`, which would
have thrown on a directory large enough to overflow the argument list and lost the whole listing.
