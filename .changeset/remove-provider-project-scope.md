---
"@agentionai/marshall-cli": patch
---

Fix removing a provider defined by the project's `.marshall/config.json` reporting success while
leaving it in place.

A provider entry can live in the global config, the project config, or both — the project file
can contribute a shared host with no key, merged field by field with anything the global file
holds for the same provider. Removing an endpoint only ever wrote the global file, so an entry
the project file actually defined survived the write untouched and reappeared on the very next
read, even though the settings menu had already reported it removed. Removal now reaches
whichever file (or both) the entry actually lives in.
