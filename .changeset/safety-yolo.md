---
"@agentionai/marshall-cli": minor
---

Rename `/safety none` to `/safety yolo`.

Level 1 removes the approval gate entirely, and `none` was the wrong word for
that: in a list of `none | default | agentic` it reads as the neutral low end of
a spectrum rather than as the setting that lets every tool call run unreviewed.
`yolo` is not a joke — it is the point. A name you are slightly reluctant to type
is doing useful work on the one mode that has no other guardrail, and the banner
already shows it in red whenever the level is not the default.

`/safety none` now returns the usage line naming the three current words. The
level is session-only and never persisted, so nothing on disk or in a config
needs migrating; only muscle memory.
