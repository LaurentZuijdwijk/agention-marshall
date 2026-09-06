---
"@agentionai/marshall-cli": patch
"@agentionai/marshall-engine": patch
"@agentionai/marshall-tools": patch
---

Update `@agentionai/agents` to 1.12.0.

The release is additive, so no behaviour changes with it yet. It brings two things worth knowing
about. Streaming agents now hand back what a turn had generated when it was cut short, on
`BaseAgent.lastPartialTurn`, on `AgentError.partial`, and as a new `AgentEvent.PARTIAL_TURN`: the
text, the reasoning trail, and any tool calls that had started to arrive, along with why it stopped
(`error`, `aborted`, `max_tokens`, or `abandoned`). It is deliberately never written to history,
since truncated tool-call JSON does not parse and an Anthropic thinking block needs the signature
that arrives last, so recovering it stays the caller's decision.

The other addition is a `reasoning-text` module exporting `collapseReasoningWhitespace()`, which
tidies the heavily bulleted chain-of-thought that GLM-series models and some OpenRouter routes
stream. It is display-only: the stored string has to go back to the provider byte for byte.
