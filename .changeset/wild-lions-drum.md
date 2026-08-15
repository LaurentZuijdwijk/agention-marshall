---
'@agentionai/marshall-cli': patch
---

Bound how much committed reasoning the transcript retains, so an all-day
session with very long thinking traces can no longer grow into a
"JavaScript heap out of memory" crash. Each committed reasoning row is capped
to its most recent 4000 characters, and once retained reasoning exceeds
60000 characters total the oldest rows are freed (kept in place so ink's
<Static> rendering stays stable). Reasoning in the transcript is display-only
and is never re-sent to the model, so this only caps memory.