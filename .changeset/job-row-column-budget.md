---
"@agentionai/marshall-cli": patch
---

Keep a finished job or agent row on one line, so the label and the outcome stop breaking apart.

A completion row renders `<icon> background <id>  <command>  •  <outcome>` as flex siblings, and `job-done` handed it the command untouched. The fixed columns sit before the content, so a long command squeezed them until the label broke: a chained `pnpm exec prettier … && pnpm test && pnpm typecheck && pnpm lint` rendered "background" as "backgrou" above a stray "d", with the job id and `exit 0  •  16.0s  •  picking it up` dragged onto a second line. It is the worst row to lose — the one that arrives with no turn running and nothing above it to anchor the continuation.

The command is now budgeted against the terminal width by `fitEventContent`, the same arithmetic `fitSafetyReason` and `fitToolContent` already use for the two other rows shaped this way, whose docblock describes this failure for tool rows. The outcome is counted as fixed rather than trimmed: it is the point of a completion row, so what gets cut is the tail of a command the user wrote and can already see in their scrollback. `job` and `spawn` now share one component, so the budget and the JSX cannot drift apart.

The command is also flattened to a single line when the event is translated. A backgrounded heredoc carries newlines, and a row containing one breaks in two however the columns are budgeted.
