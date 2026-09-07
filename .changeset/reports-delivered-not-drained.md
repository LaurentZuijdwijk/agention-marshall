---
"@agentionai/marshall-engine": patch
---

Reports from agents and background jobs that finish mid-turn are no longer lost to the model
that asks for them.

A finished agent's report, like a finished job's output, is queued and delivered at the front of
the next turn — the only point where injecting it is safe. But the queue drained the report out
of the registry at enqueue time, so a parent still working when its agent finished found
`agent_output` answering "its report has already been delivered to you" about words that were
sitting in the queue, and `shell_output` answering "no new output" for a command whose output was
exactly what it had gone to read. Observed live: a parent that could not read any of its eleven
agents' reports during a ten-minute turn, and re-ran its test command with output redirected to
files to get around it.

The queue now renders each report when it is delivered. Whichever reader comes first — the model
asking, or the wake-up at the next turn — gets the body, and the other says it was already read.
`agent_output`'s description says so. Running agents also now report when their last tool call
returned, since elapsed time alone cannot tell thinking from wedged.
