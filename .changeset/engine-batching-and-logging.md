---
"@agentionai/marshall-engine": minor
---

Tell the model to batch its file calls, and log what a turn actually cost.

The coder's `FILE_RULES` and a spawned agent's rules now both say to put every change to one file
in a single `edit_file` call, to keep each `oldString` only as long as uniqueness needs, and to
batch unrelated searches and directory listings through `patterns[]`/`paths[]`. The guidance lives
in the same two places, so a sub-agent is told what the coder is told.

They also now say to take in several files with one `run_shell` call
(`grep -rl PATTERN src | xargs cat`) rather than one `read_file` each, and that `read_file` is for
understanding code rather than for unlocking an edit — `edit_file` no longer requires a prior read
(see `@agentionai/marshall-tools`). Measured on a 28-file migration against `z-ai/glm-5.3-flash`,
those two changes together took a run from 37 tool calls and one timeout in two attempts, to 14
calls and two of two passing. The same wording is in `read_file`'s own description, so the prompt
and the schema cannot drift apart.

Two things a run's cost is made of were invisible in the session log. Tool failures are one: every
tool in the belt reports failure by *returning* a string rather than throwing, so a refused edit —
an `oldString` matching nothing, a write blocked because the file changed — left no trace once the
turn ended, while the model paid to re-emit the whole edit body on the retry. Those now log as
`TOOL_FAIL`. Assistant narration between tool calls is the other, and the largest single component
of output tokens; its length now logs as `ASSISTANT_TEXT`. `TOOL_CALL` carries the full argument
length alongside its truncated preview, since a 200-character preview cannot measure a batched
edit payload running to thousands.

Adds `maskToolResults` (default unchanged) to keep every tool result verbatim and drop
`retrieve_tool_result` from the belt. Masking keeps a long conversation small at the cost of the
model no longer seeing what a tool returned more than `maskingKeepRecent` results ago — which, on
a task that reads many files and then edits them, is exactly the content it is about to need.
