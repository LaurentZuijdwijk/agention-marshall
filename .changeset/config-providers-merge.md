---
'@agentionai/marshall-cli': patch
---

Stop a project-local `.marshall/config.json` from hiding stored API keys for providers it
doesn't mention.

`loadConfig` deep-merged the project config on top of the global one, and the generic merge
replaces arrays wholesale — so a project pinning one provider (e.g. a `providers` entry for
`llamacpp` left over from before credentials moved to the global config) silently discarded
every other provider's entry from the merged view, including a stored API key. The `/model`
wizard's key step then saw no stored key and correctly refused to advance on a bare enter,
which looked like the enter key had stopped working. `providers` is now merged by provider
name — a project can still override a provider it names, but no longer erases providers it
doesn't mention.
