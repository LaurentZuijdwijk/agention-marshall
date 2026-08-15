---
"@agentionai/marshall-cli": patch
---

Format large token counts and long turn durations more compactly in the live status row.

Token counts of 10,000 or more now abbreviate to `1.5k`, `10k`, `1.5M` instead of long
comma-grouped digits, and a turn (or a first-token wait) running a minute or longer now shows as
`24m59s` or `1h05m` instead of raw seconds, both dropping trailing zero segments (`10k`, not
`10.0k`; `5m`, not `5m00s`). Scoped to this status row alone: the `/tokens` report and the rest
of the transcript keep full comma-grouped counts, where precision reads better than compactness.
