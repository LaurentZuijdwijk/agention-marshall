---
"@agentionai/marshall-engine": patch
---

Stop compression from splitting a tool call away from its result, which made OpenAI, Azure and
OpenRouter reject the next request with a bare 400 ("Missing tool call ID reference for function
call outputs") that was then misreported as a full context window.

The summary window is now aligned so a tool call and its result are kept together or summarised
together, never half of each; a reduce that would still break a pairing is skipped rather than
producing a history the provider rejects. The 400 itself is now recognised for what it is across
the phrasings OpenAI, Azure and OpenRouter actually use, so it is reported instead of triggering a
pointless compression pass. Sessions already carrying a broken pairing repair it before the next
request rather than failing every turn from there on.

Error classification is now one function (`classifyProviderError`) instead of the same condition
duplicated at two call sites, and the session log names the rule that fired and whether it
triggered compression (`kind=`, `because=`, `COMPRESSION_TRIGGERED_BY_ERROR`, `NO_COMPRESSION`).
Content-filter rejections, invalid tool schemas and unsupported-parameter errors are now reported
instead of spending a compression pass and being handed back as a full context window.

Two repair details that the pairing work depends on: a cancelled tool call is now answered
directly after the message that made it rather than at the end of history, so a break inherited
from mid-conversation actually heals instead of producing a second rejection; and the repair no
longer rebuilds history in a way that discards entry metadata, which had been erasing the marker
that identifies a compression summary and causing an existing summary to be summarised again as
if it were an ordinary turn.
