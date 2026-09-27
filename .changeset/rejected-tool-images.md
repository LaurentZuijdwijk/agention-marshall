---
"@agentionai/marshall-cli": patch
"@agentionai/marshall-engine": patch
"@agentionai/marshall-tools": patch
---

Recover from an image a model cannot read when the image came from a tool rather than the task.

A screenshot returned by an MCP server reaches the model through `ToolConfig.attachImages`, not through `run()`'s `images` argument, so the `hasImages` gate on `classifyProviderError` never saw it. A llama.cpp model with no mmproj loaded rejects that request, the rejection was classified as a generic error instead of `image-rejected`, and the synthetic history entry carrying the image was left in place — so every following turn resent it and failed identically, with no way back short of restarting the session.

The gate now reads history rather than only the turn's attachments, which also covers the turns after the one that took the screenshot. Recovery strips any image the popped tail did not reach, leaving a note in its place so the model is told why the screenshot is missing. And the rejection is remembered for the session: a later screenshot is described in text, naming the reason, instead of being attached and rejected again. Switching the deep model forgets it, since it was learned about the model being replaced; switching only the fast model does not, because the model that rejected the image is still the one that would be handed the next screenshot.

The same check now also covers the tool path on ollama, whose transformer drops image blocks before the request is sent — previously refused for a task attachment but not for a tool's screenshot, which left the model answering about an image it was never sent.
