---
"@agentionai/marshall-engine": patch
"@agentionai/marshall-tools": patch
---

Fix the `openai` and `gemini` providers, which both failed on the first request
of every session, by taking `@agentionai/agents` 1.6.0-beta.0. Three bugs, all
fatal on their own and all fixed upstream:

- OpenAI tool definitions went out with `strict: true` unconditionally, and
  OpenAI rejects a strict schema whose `required` list does not name every
  property — so the ten tools with an optional parameter (`read_file`'s line
  range, `search`'s path filters, the `gh_*` filters) turned into a 400 before
  the model ran.
- Gemini tool results were sent as a bare JSON string where the API types
  `functionResponse.response` as a protobuf Struct, which came back as a 400
  quoting the whole tool output.
- the `thoughtSignature` Gemini 3 returns with each function call was dropped by
  the history transformer, so replaying the call failed with "Function call is
  missing a thought_signature". Gemini 2.5 did not require them and is no longer
  offered on new API keys, so this affected every model a new user can reach.

A bad request that compression cannot shrink and that never mentions context
also stops being reported as "context window full", which is how the OpenAI one
hid: the CLI reported a full context window over a 921-token history.
