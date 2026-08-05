---
'@agentionai/marshall-engine': minor
'@agentionai/marshall-cli': minor
---

Add `/goal`, a destination-first sibling to `/plan`.

`/plan` starts from "what steps"; `/goal` starts from "what does done look like" and only
sketches a rough breakdown once that's pinned down — success criteria and scope stay separate
from exact files and edits, which is still `/plan`'s job. Runs on the same tier as `/plan` and
shares its pending-context slot, so the result primes the next task the same way a plan does.
