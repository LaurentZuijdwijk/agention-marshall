---
'@agentionai/marshall-engine': minor
'@agentionai/marshall-cli': minor
---

Add light mode — a lean tool belt for small models.

`--light`, `"light": true` in config, or `/light` in the session. It drops the scratchpad
(`note_*`/`log_*`), background jobs (`run_shell`'s `background` option and the `shell_*`
tools) and every sub-agent (`context`, `search`, `planner`, `reviewer`), leaving
read_file/list_dir/search/write_file/edit_file/run_shell. Measured on a tiered setup: 16
tools down to 7, and the fixed per-request overhead from ~2130 tokens to ~955 — a 55% cut,
which on an 8k local model is a quarter of the window handed back.

The system prompt is now built from the belt rather than being a fixed string. It had
hardcoded rules about `note_write`, `log_append` and backgrounding, and a rule describing a
tool the model does not have is worse than no rule: it spends tokens teaching a call that can
only fail. `buildSystemPrompt` composes only the rules whose tools are present, which is the
same way the `context`/`planner`/`reviewer` guidance blocks already worked.

`/light` takes effect on the next message, since the belt and prompt are rebuilt per turn.
