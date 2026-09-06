---
"@agentionai/marshall-cli": patch
---

Fix status and tool-call rows overflowing on a narrow terminal.

The live status row ("generating · ↑1.3M ~617/s · 2h19m · …") had no width budget at all, so on
a narrow terminal it ran past the edge and the terminal hard-wrapped it mid-character — turning
"generating" into "generatin" on redraw. It now sheds fields as the terminal narrows, least
essential first (time-to-first-token, then cost, then elapsed duration, then the `~x/s` rates),
always keeping the raw token counts. A contributing cause is fixed too: the spinner's own elapsed
counter used unabbreviated seconds instead of the same `2h19m`-style formatting the row's duration
field already used, so a long-running turn could blow the budget on that one number alone.

A top-level `run_shell`-style tool-call header (`● Run shell <command>`) had the same gap its
nested-agent sibling already had a fix for: the command text rendered unbounded, so on a narrow
terminal the label and command could run together with the separator swallowed by the wrap. It now
truncates with an ellipsis the same way.
