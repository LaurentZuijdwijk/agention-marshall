---
"@agentionai/marshall-cli": minor
---

Add `--version` to print the installed version and exit. Doubles as what the Harbor/Terminal-Bench
agent adapter (`bench/harbor_agent/`) reads back via `get_version_command`, so which marshall
build produced a trial is recorded in the result rather than left implicit.
