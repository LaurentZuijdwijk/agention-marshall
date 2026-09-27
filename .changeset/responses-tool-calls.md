---
"@agentionai/marshall-cli": patch
"@agentionai/marshall-engine": patch
---

Show tool calls made on the `openai` and `codex` providers.

Those providers use the Responses API, which reports a tool call as `{ type: 'function_call', name, arguments }`. The engine only recognised Anthropic's `tool_use` block and the chat-completions `function` block, so every call on them was dropped before it reached the client: no tool rows in the transcript and no `TOOL_CALL` lines in the session log, though the tools themselves ran and the task still got done. A bench run on Codex that fixed two bugs with a dozen shell commands reported zero tool calls, which is how it surfaced.
