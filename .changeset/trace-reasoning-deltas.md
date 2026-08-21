---
"@agentionai/marshall-engine": patch
---

Add `MARSHALL_TRACE_REASONING=1`, which appends each raw reasoning delta to
`.marshall/logs/reasoning.log`, one JSON-encoded string per line.

The session log records what you typed and which tools ran; neither it nor the history trace
shows what a provider's reasoning stream actually looked like on the wire. That mattered when
reasoning started rendering one word per row and the question was whether the line breaks came
from the endpoint or from us — unanswerable from any existing log.

JSON-encoded rather than written raw, because the whole question this answers is about
whitespace, and a log that prints the text plainly hides exactly the thing being looked for.
Off by default, read from the environment at call time like `MARSHALL_TRACE_HISTORY`, so turning
it on is a restart and turning it off costs nothing.
