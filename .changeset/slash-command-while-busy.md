---
"@agentionai/marshall-cli": patch
---

A slash command typed while a task is actively running now applies immediately instead of being
silently queued as if it were agent input. Queuing captured every submission the same way while
the session was busy, with no exception for `/model`, `/clear`, `/jobs`, and the rest — so
`/clear` typed mid-turn used to sit in the queue and, once dequeued, get sent to the model as the
literal text `"/clear"` rather than actually clearing anything.

Most commands are safe to run at any time — reads, background-job/agent management, and config
the engine already re-reads fresh each turn (`/runtime`, `/safety <level>`) either touch nothing
an active turn depends on, or the engine's own guard (`Session.refuseIfBusy`, `Session.clear()`)
already covers them cleanly. The exception is the handful that open a wizard and replace `mode`
outright (`/setup`, `/model deep|fast|both`, `/safety agentic`, `/mcp add`, `/team add`, `/login`)
— letting one of those steal `mode` out from under a turn that is still actually running would
manufacture the exact "mode says idle, `session.busy` says otherwise" mismatch `handleSubmit`
already has to account for elsewhere. Those now refuse clearly ("a task is running — interrupt it
first") rather than being let through.
