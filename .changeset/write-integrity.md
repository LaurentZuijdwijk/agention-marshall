---
"@agentionai/marshall-tools": patch
---

Fix three ways a write tool could lose data: a truncated read authorizing a whole-file
overwrite, a lost `log_append` entry under concurrency, and a file's permissions resetting on
every atomic write.

`write_file` compared its hash against `read_file`'s last snapshot to catch a stale overwrite,
but a file larger than the read cap was hashed from only the observed prefix — so a whole-file
write could go through on a hash that never saw the rest of the file, silently discarding
anything beyond the cap. Whole-file writes are now refused unless the file was read in full;
`edit_file` remains available for a targeted change to a large file.

`log_append` read the log, then wrote it back, with nothing serializing two concurrent
appenders — the session log's own lock now covers this the same way it already covers
`write_file`/`edit_file`, so two agents (or a spawned agent and its parent) logging at once no
longer lose an entry to a lost update.

`atomicWrite` writes to a temporary file and renames it into place, which used to reset the
destination's permissions to the new file's default mode. It now preserves the existing file's
mode across the rename when there is one to preserve.
