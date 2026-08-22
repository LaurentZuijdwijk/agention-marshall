---
"@agentionai/marshall-cli": patch
---

Fix the `--max-old-space-size` respawn wrapper always exiting 0, regardless of the child
process's actual exit code. Silent under the interactive REPL, where nobody checks `$?` after
quitting — but it would have made every failure in the new `--message` headless mode read as
success to whatever invoked it. A signal with no exit code (the child was killed) now reports 1
rather than defaulting to 0.
