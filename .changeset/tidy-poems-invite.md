---
"@agentionai/marshall-cli": minor
"@agentionai/marshall-engine": patch
---

Persist runtime and safety settings, and replace `/light` with `/runtime`.

**Breaking:** `/light` is now `/runtime [default|light|agentic]`. The old command
toggled; the new one names the mode you want, and remembers it. `/runtime` on its
own reports the current mode. Add `--global` to save it for every workspace
instead of just this one. It is not called `/mode` because that is a strict
prefix of `/model`, which made tab completion rewrite a complete, valid command
into a different one.

Safety levels 2 and 3 are now persisted too, together with the judge model chosen
by `/safety agentic`, so turning a real approval gate on is not something you have
to redo every morning. Level 1 (`yolo`) is deliberately never written: a gate that
disables itself again on the next launch, from a file that can be committed, is
not a decision anyone should be able to make once. The stored judge records
provider, model and host but never an API key, and is authenticated at load time
from the global config or the provider's environment variable.

All non-secret settings now live under a versioned `settings` key in
`.marshall/config.json` or the global config, with one reader and one writer
(`services/settings.ts`). A settings block from an unrecognised version is ignored
rather than half-read, invalid values are reported at startup rather than silently
applied, and a level-3 gate whose judge cannot be validated is read back as level 2
rather than as no gate at all.

Fixes along the way:

- An `apiKey` in the project-local `.marshall/config.json` is now ignored and
  reported, wherever in the file it appears. That file is meant to be committed.
- Choosing a model no longer wipes the rest of the global config. `saveConfig`
  rebuilt the file from the model tiers alone, so a configured MCP server or
  settings block survived exactly one `/model`.
- A project config pinning one provider's host no longer erases the API key stored
  globally for that same provider.
- `Session` gained a `safetyAgent` getter. Reading the gate back off
  `safetyAgentProfile` dropped `kind` and `maxOutputTokens`, which silently
  downgraded a content-safety judge to the default chat-judge shape.
- The header's `mode` row now tracks `/runtime` instead of showing the value it
  booted with.
