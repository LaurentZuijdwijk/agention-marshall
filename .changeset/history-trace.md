---
"@agentionai/marshall-engine": minor
---

Add `MARSHALL_TRACE_HISTORY`, which writes the conversation as the model receives
it to `.marshall/logs/history.log`, once before and once after every turn.

The session log records the task and the tool calls but never what was sent, so
"the agent forgot the previous answer" had no answer short of instrumenting the
engine by hand — a missing history entry, one the masking plugin rewrote on the
way out, and a model that simply ignored the context all look identical from
outside. The `before` record for a turn is exactly the document the model was
given for it, and tool results a transform changed are marked `[masked]`.

`=full` skips truncation. Off by default, and the file quotes your code, so treat
it the way you would the source it came from.
