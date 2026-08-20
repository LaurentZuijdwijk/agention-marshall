---
"@agentionai/marshall-tools": patch
---

Fix line count reporting, partial reads, and line numbering in `read_file` to match grep and standard line numbering across long files.

`read_file` and `search` now stream rather than reading whole files, so `maxFileBytes` bounds
what is held in memory and not just what is printed — a file too large to hold as a string is
still readable and searchable. Line ranges are validated: a reversed or non-numeric range is an
error instead of a `NaN` header. `\r` is preserved, so an `edit_file` `oldString` copied out of
a `read_file` render still matches a CRLF file.

`write_file` now requires a read with no line range before replacing a file wholesale, and says
which of the two reasons it is refusing for — a range read is fixed by re-reading without one,
and only a file over the read limit needs `maxFileBytes` raised. An `edit_file` in between no
longer counts as having read the file: matching a unique substring renders none of the rest, so
a ranged read followed by an edit stays a ranged read rather than unlocking the overwrite the
gate exists to refuse.
