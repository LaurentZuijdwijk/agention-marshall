---
"@agentionai/marshall-cli": patch
"@agentionai/marshall-engine": patch
---

Read tool calls from `@agentionai/agents`' `TOOL_CALLS` event (1.17.0) instead of parsing each provider's `TOOL_USE` payload.

The engine recognised only the shapes it had been taught, and dropped the rest without a trace: every call on `openai` and `codex` until 0.25.5, and still every call on `gemini` and any Mistral call sent without its optional `type`. `TOOL_CALLS` carries the same calls in one shape for every provider, so there is no longer a per-provider list here to fall behind. Narration still comes from `TOOL_USE`, which the library emits first, so it keeps its place above the calls it introduces.
