---
"@agentionai/marshall-tools": minor
---

Show `write_file` approvals as a diff instead of a preview of the new content.

`edit_file` already rendered a diff; `write_file` showed the first 800
characters of what it was about to write and never compared against the file on
disk. That was a way around the gate rather than a cosmetic gap: to change line
200 of a long file without it appearing in the approval, an agent could avoid
`edit_file` and rewrite the whole file instead, and the panel would show an
unchanged, benign-looking prefix with the actual change sitting past the cutoff.

What you are shown now scales with the size of the change rather than the size
of the file, so there is nowhere past a cutoff to hide: a two-line change renders
as two lines whether the file is 50 lines or 5,000, and an approval that looks
empty means nothing changed. Where a diff is itself truncated you are told how
many further changed lines exist. The summary line states the shape up front
(`write_file: config.ts (+2 −1, 480 unchanged)`), since a whole-file write that
changes two lines is the signature of exactly that manoeuvre.

Creating a new file has nothing to diff against and still shows its content.
