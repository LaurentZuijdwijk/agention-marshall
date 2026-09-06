---
"@agentionai/marshall-cli": patch
---

Fix the status row still overflowing when the ctrl-e hint or a queued-prompt count was showing.

The previous fix budgeted only the metric segment (token counts, duration, ttft, cost) against the
terminal width — it missed that "ctrl-e to skip thinking" and a queued-prompt count are separate
`<Text>` siblings on the same row, so a `thinking` turn with reasoning-skip available could still
overflow even with every metric field already shed. The row's full width — spinner, metric, hint,
and pending count together — is now what gets budgeted, with the hint dropped first (it's a
convenience, not data) and the pending count kept unconditionally (it's telling you work is
waiting, not decorating the row).
