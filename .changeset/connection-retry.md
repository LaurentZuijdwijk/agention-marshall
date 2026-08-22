---
"@agentionai/marshall-engine": minor
---

Retry a dropped connection mid-turn instead of ending it. A `'connection'`-classified provider
error (`fetch failed`, `terminated`, `ECONNRESET`, ...) is not the provider saying no — the
request was simply never answered — so it no longer goes straight to the client as a failure.
History already holds everything the turn did up to the drop (tool calls, their results,
reasoning), so the retry is a short "continue where you left off" nudge, not a resend of the
original task. Bounded (`EngineConfig.maxConnectionRetries`, default 3) with exponential backoff
plus jitter (`connectionRetryBaseMs`, default 2000ms, capped at 30s) — a genuinely dead endpoint
still ends the turn and reports the error, just after giving it a real chance to recover first.

Surfaced by a Terminal-Bench run where a long tool-calling turn (5+ hours, 330K input tokens of
real progress) was thrown away entirely by one transient network blip.

Also fixes `isConnectionError` not matching `terminated` — Node's `fetch` error for a socket the
far end closed mid-response, and, on a very long turn, one of the more likely ways to see this at
all.
