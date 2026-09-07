---
"@agentionai/marshall-tools": patch
---

The read gate judges a read by what it rendered, not by how it was asked for.

`write_file` needs the whole file read first. Told to "call read_file again without a line
range", a model asked for lines 1–100000 instead — every line — and was refused as a partial
read; then a full read did unlock the write, and two ranged re-reads of one section of the
unchanged file locked it again. Meanwhile the oversized-edit refusal was telling it to use
`write_file`, which it could not. It gave up and spent four minutes editing the file in pieces.

A ranged read that renders every line now counts as complete, and a ranged re-read of a file
already read whole keeps that coverage as long as the file's hash is unchanged — the moment the
file moves on, a ranged read is partial again. The oversized-edit refusal from `edit_file` and
`edit_lines` now says, when the read on record would not unlock `write_file`, what would.
