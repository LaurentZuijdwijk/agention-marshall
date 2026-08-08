---
"@agentionai/marshall-engine": minor
"@agentionai/marshall-cli": minor
---

Add safety level 3: a model reviews each tool call before you do.

`EngineConfig.safetyLevel` is now `1 | 2 | 3` — no gate, human-in-the-loop (the
default, unchanged), or agent-reviewed. At level 3 a dedicated judge model sees
each state-changing call first. A confident "safe" verdict approves it outright
and you are never interrupted; an "unsafe" verdict does *not* block, it annotates
the approval with the judge's reasoning and still asks you, so a false positive
costs a keystroke rather than the task. A judge that fails, times out or answers
unparseably also defers to you. The judge can only ever skip asking about things
it is confident are fine.

In the CLI: `/safety [none|default|agentic]`, session-only like `/light` rather
than persisted, with `agentic` opening the model picker to choose the judge. The
banner shows a `safety` row whenever the level is not the default, and each
verdict appears in the transcript under the call it judged — approvals included,
since a call you were never asked about is exactly the one whose review would
otherwise be invisible. Every judge call is logged in full to
`.marshall/logs/session.log`.

Two judge prompt shapes are supported: `chat-judge` for ordinary
instruction-following models, and `nvidia-content-safety` for guard-style
classifiers. Testing against real local models says to prefer the former, even a
small fast one, and to judge a judge by its false-approve rate rather than raw
accuracy — a denial still reaches you, an approval does not. See
`docs/agent-based-safety.md`.
