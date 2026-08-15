---
'@agentionai/marshall-cli': patch
---

On startup the CLI now re-executes itself with `--max-old-space-size` raised to
8 GB (override with `MARSHALL_MAX_OLD_SPACE`, in MB) when no heap flag is
already set, so very long sessions whose reasoning trace grows large no longer
die with "JavaScript heap out of memory". The wrapper skips the respawn when the
flag is already present, including via `NODE_OPTIONS`.