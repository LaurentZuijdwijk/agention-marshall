---
"@agentionai/marshall-cli": patch
---

Stop a saved endpoint's name from surviving a switch to a different, unnamed provider.

Both `--provider` at startup and a `/model` or settings-menu switch mid-session could carry a
previously-saved endpoint's `name` onto an unrelated provider — e.g. an `openai-compatible`
endpoint named "LM Studio" showing up in the header next to `llamacpp` after switching to it.
Because the resulting profile is what gets persisted, this also wrote the mismatched name back
into the saved config, so it kept reappearing on every later launch until fixed at the source.
Both paths now only keep a saved name when the provider it names is the one actually in use.
