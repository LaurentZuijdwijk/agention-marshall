---
"@agentionai/marshall-cli": patch
---

Fix two ways the assistant's transcript text could render misaligned: a stray leading space on
some wrapped lines, and a reply landing on the row below its bullet instead of beside it.

Ink's default text wrap calls `wrap-ansi` with `trim: false`, which leaves a stray leading space
on the row after a word happens to land exactly on the column width, a ragged left edge on
otherwise flush prose. Patched via `patch-package` (`patches/ink+7.1.1.patch`) to use
`wrap-ansi`'s own default (`trim: true`) instead, which does not have this problem.

Separately, a response (or reasoning block) that opened or closed with a blank line kept that
whitespace when it was pushed to the transcript, even though the code already checked
`text.trim()` before deciding whether to push at all. Since the assistant's bullet sits beside
the message's first rendered row, a leading blank line rendered as an empty row above the real
one, making the bullet look orphaned. The text pushed is now the trimmed value, not just gated
on it.
