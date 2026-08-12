---
"@agentionai/marshall-engine": patch
---

Safety agent now strips markdown fences before parsing JSON verdicts.

`stripFence` removes ` ```json ... ``` ` and ` ``` ... ``` ` wrappers
from model output so the verdict parser can handle models that wrap
their JSON response in a code block. Previously a fenced response
would fail to parse and the call would be denied by default.
