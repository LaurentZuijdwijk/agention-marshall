---
"@agentionai/marshall-engine": minor
"@agentionai/marshall-cli": patch
---

Fix a prompt silently dropped when it was typed the instant a finished background job or agent
woke the coder back up, and Esc doing nothing during `/plan`, `/goal` or `/review`.

`Session` used to announce a turn's `thinking` event only after that turn's setup (MCP
settling, compression, building the agent) finished, so a client watching the session had no way
to tell "about to be busy" from "already busy." A prompt submitted into that window reached
`run()`, hit its concurrency guard, and was reported as an error and lost rather than queued.
`Session` now announces a turn the moment it claims the session, and exposes a new `busy` getter
so a client isn't left inferring session state from the event stream. The CLI now queues a
prompt typed into that window instead of losing it.

Separately, `/plan`, `/goal` and `/review` never checked for an interrupt before their model
call and never raced the call itself against one, so pressing Esc during setup or while the
call was in flight did nothing — the run() path already handled both correctly, and the two
now share one implementation so a fix to this class of bug can't land in one and miss the
other.
