---
"@agentionai/marshall-tools": minor
---

Batch `edit_file`, `search` and `list_dir`, and render `read_file` without a gutter.

`edit_file` now takes `edits[]` — every disjoint change to one file in a single call, each
`oldString` matched against the file as last read and applied in reverse offset order, so
earlier replacements never shift later ones. Failures are reported per index and the file is
left untouched unless every edit resolves. The single `oldString`/`newString` pair still works
and is folded into a one-element batch, so no existing caller breaks. `search` and `list_dir`
gain the same shape (`patterns[]`, `paths[]`) for the same reason: several unrelated greps or
listings are one round trip rather than one each. A one-item batch renders exactly as the
single-item call always did.

The measurement behind it: a 28-file migration spent 143 `edit_file` calls on work that batches
into 28. The cost of a call is not its payload — runs whose payloads were *larger* emitted
60-108% fewer output tokens than runs with many small ones — but the per-call envelope, the
repeated path, and the model's own preamble around each one.

`read_file` no longer prefixes a `12 | ` gutter by default. `Limits.readLineNumbers` restores it
for programmatic callers of the engine; the CLI does not yet surface `limits`, so there is no
setting for it there. A gutter makes content easy to refer to and impossible to copy: `edit_file` matches an
exact string, so every `oldString` had to be reconstructed rather than lifted from what was just
read. Model reasoning traces showed each pair being drafted in full inside `<think>` before being
emitted again as arguments, then repaired when that went wrong.

When an `oldString` misses exactly, a fallback is tried once against a normalized copy, with an
offset map so the bytes replaced are the real ones. It is narrower than "whitespace-tolerant":
it folds smart quotes and unicode dashes to ASCII and ignores *trailing* whitespace per line.
Interior runs of spaces are still significant, so `a  b` does not match `a b`. A curled quote or
a dropped trailing space no longer costs a full re-emission of the edit body. Because a
loose match means the caller's idea of that text has drifted from the file's, the result now says
so; an exact match reports nothing extra.

A bare `*` or `**` `fileGlob` now means "every file", as it reads. It was matched as a literal
substring, so it selected no ordinary filename and reported the glob as the reason nothing was
searched — a wasted round trip for an input meaning exactly what no glob at all already means.

**`edit_file` no longer requires the file to have been read first.** The `oldString` is the
evidence: it has to occur exactly once in the file as it stands, so an edit built on content the
caller came by some other way — a shell `cat`, a search hit, a file it just wrote — either lands
where it was meant to or fails `not-found`/`ambiguous` and says so. The read requirement bought no
safety on top of that and cost a round trip per file; measured on a 28-file migration, it was the
difference between 37 `read_file` calls and 10. It also blocked an ordinary case outright: editing
a file you have just written yourself.

Two things deliberately keep the gate. `write_file` still needs a complete prior read, because it
replaces the whole file including the parts never looked at and has no `oldString` to validate
against. Line-addressed edits (`startLine`/`endLine`) still need one too — line 12 is whatever line
12 currently is, so the request carries no evidence and is only meaningful against the version
whose numbers the caller actually saw; that now has its own check and message rather than leaning
on the blanket gate. Editing a file that does not exist reports that, instead of the raw `ENOENT`
the blanket gate used to mask.

`read_file`'s description now points at `run_shell` for taking in several files at once
(`grep -rl PATTERN src | xargs cat`) rather than calling it once per file — honest advice only
because the gate is gone, since content obtained that way is now enough to edit from.
