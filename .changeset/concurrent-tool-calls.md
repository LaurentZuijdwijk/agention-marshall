---
"@agentionai/marshall-tools": minor
"@agentionai/marshall-engine": minor
---

Fix two ways concurrent tool calls lost work or consent.

Models routinely batch several file calls into one message, and the agent SDK
runs that batch concurrently. Both of these were live, not theoretical.

**Edits to one file raced.** `edit_file` reads, computes and writes across an
`await`, so parallel edits all read the same original and only the last write
survived — while every call still reported `Edited`. Writes to a path are now
serialised, keyed per path so edits to *different* files still run in parallel.
Whole-file writes cannot be fixed by serialising, since each carries complete
content built from the same read, so `write_file` now refuses a write whose
expectation of the file no longer matches disk and points at `edit_file`, which
composes. A write composed before someone hand-edits the file in their editor is
refused for the same reason, instead of silently discarding their change.

**One approval answered for calls you never saw.** The gate coalesced in-flight
requests by tool name, so a batch of writes to three different files cost one
prompt: you were shown one file, and approving it wrote the other two unseen.
Denying one denied all three. Requests now key on the tool, the arguments and
the calling agent, so only genuinely identical calls share a decision.

**You will see more prompts than before.** A batch of three writes to three
files now asks three times, because it always should have. `ToolCaller` also
gains an optional `id` naming the agent instance rather than its role, so two
agents on one role are not treated as one actor by the gate, the approval panel
or the safety judge.

Read tracking (`read_file` before writing an existing file) moves to session
scope via `ToolConfig.readFiles`, fixing a case where reading a file in one turn
and editing it in the next failed with "has not been read this session".
