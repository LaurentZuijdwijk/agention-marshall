---
'@agentionai/marshall-cli': minor
---

Add `/config repair`, which fixes the two config problems that are
unambiguous rather than merely stale: a pre-tier flat model choice, and an
`apiKey` that leaked into the committed project file (re-homed into the
global providers list, where secrets belong).

Config reads and writes were also rewritten for reliability: writes now
validate strictly (unknown provider fields rejected, local providers require
a non-empty host) while reads stay lenient so a malformed file degrades
per-field instead of crashing startup; every write is read-fingerprint →
transform → verify → atomic rename, so a concurrent write from another
instance is detected and retried instead of silently lost; and a missing or
unwritable `$HOME`/`$XDG_CONFIG_HOME` no longer crashes first run.
