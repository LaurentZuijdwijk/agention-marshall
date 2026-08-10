---
'@agentionai/marshall-engine': minor
---

Identify Marshall to OpenRouter, so its traffic is attributed to the app.

Every request on an `openrouter` profile now carries OpenRouter's app-attribution
headers: `HTTP-Referer: https://marshall.agention.ai` (the identifier the
rankings and the per-app analytics key on), `X-OpenRouter-Title: Marshall` (the
display name) and `X-OpenRouter-Categories: cli-agent`. Without the referer
there is no app page at all, so a title on its own would have done nothing.

They ride on the agent library's `defaultHeaders`, which requires
`@agentionai/agents` 1.4.0 — the dependency moves with it.

They are sent for gateway hosts too, not just openrouter.ai: a proxy in front of
OpenRouter forwards them, and anything else ignores headers it does not know.
Nothing about the request itself is disclosed, and no other provider is touched.
