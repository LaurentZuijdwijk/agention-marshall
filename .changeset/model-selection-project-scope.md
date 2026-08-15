---
"@agentionai/marshall-cli": minor
---

Save which model a workspace uses to that workspace's project file, and the credential that
makes it reachable to the global file, so switching models in one project no longer changes the
default for every other project on the machine.

`saveProfiles` (`/model`, the setup wizard) always wrote both the model choice and its
credential to the global config, which applies to every workspace. `withModelSelection` now
writes the credential-free model choice to `.marshall/config.json`, and `withProviderCredentials`
writes the host and key to the global file, matching what the config layering already documented
as the intent but the write path never did. A saved model in the old flat, pre-tier shape still
loads fine, but now gets a startup note pointing at `/model` to move it onto the new split.

Fixed a related gap this surfaced: the fast tier's saved API key stopped being found once the
model selection no longer carried it inline, for both a same-provider and a split-provider fast
tier. Both now fall back to the stored provider entry the same way the host already did.
