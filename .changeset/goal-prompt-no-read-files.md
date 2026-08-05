---
'@agentionai/marshall-engine': patch
---

Stop `/goal` from looping on its own read-file instructions.

`GOAL_AGENT_PROMPT` told the model to read files to "verify its understanding" before
answering. On a small local model this sent it into a stuck loop re-issuing
`list_dir`/`read_file` on a near-empty new project, since there was nothing there for "verify
what exists" to find. The goal is answerable from the task description alone far more often
than a concrete implementation plan is — read-only tools are still available if a task
genuinely needs them, but nothing in the prompt pushes toward using them now.
