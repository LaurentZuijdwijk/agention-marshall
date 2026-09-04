# TODO

## Stream `edit_file` and the write-approval diff

`read_file`, `search` and `fileHash` are all bounded now — `readLineWindow`
(`src/primitives/line-window.ts`) streams and holds only the requested window,
and `search` caps each file at `MAX_SEARCH_FILE_BYTES`. Two reads are still
unbounded:

- `edit_file` (`src/factories/file/read-gate.ts`) — `await readFile(resolved, 'utf8')`.
  On a 200 MB file that is the buffer, the decoded string, and another copy from
  the splice: roughly 600 MB peak for a one-line edit.
- `describeWrite` (`src/factories/file-tools.ts:515`) — `readFileSync` on the
  current file, to diff it against the proposed write. Synchronous, so it blocks
  the event loop for as long as it takes, on the approval path.

A cap is not an option for `edit_file`, which is why it was left alone when the
others were fixed: it is a read-modify-write, so reading only part of the file
and writing the result back would silently truncate it. Streaming is the only
way to bound it.

The asymmetry this leaves, which is the visible symptom:

```
read_file  { path: 'huge.bin', startLine: 1, endLine: 1 }  →  # huge.bin  (lines 1–1 of 600)
edit_file  { path: 'huge.bin', oldString: 'needle', ... }  →  Error: Invalid string length
```

A file over ~512 MB (V8's `MAX_STRING_LENGTH`) can be read but not edited, and
the refusal is V8's message passed straight through — nothing a model can act
on. The size wall is the least of it; the memory cost on ordinary large files is
the real reason to do this.

### Shape

Two passes over the file, neither holding more than a window:

1. Count occurrences of *every* `edits[].oldString` with a single sliding scan
   that carries `max(oldString.length) - 1` bytes of overlap between chunks, so
   a match straddling a chunk boundary is still found. The "must appear exactly
   once" check needs the count across the whole file, so this pass cannot
   short-circuit at the first hit.
2. Copy bytes to the temp file, splicing each replacement in at its recorded
   offset, in ascending order.

**Note the batching interaction.** `edit_file` now takes `edits[]` and applies
them by locating all of them against the original and splicing from the back
(`src/primitives/apply-edits.ts`). That is an in-memory design, and it is the
thing streaming has to preserve: pass 1 must collect offsets for *all* edits,
not one, and pass 2 walks them in ascending order rather than reversing (there
is no shifting to undo when writing to a fresh file). The overlap check stays
where it is — it only needs offsets, not content.

The whitespace/quote-normalizing fallback is the harder part to stream: it
currently builds a normalized copy of the whole file with an index map. Bounding
it means normalizing per window and carrying enough overlap to catch a match on
a boundary, or accepting that the fallback is skipped for files above the cap.

Needs a streaming variant of `atomicWrite` (`src/primitives/atomic-write.ts`),
which currently takes the full content as a string.

`describeWrite` is a separate, smaller fix: the proposed content is already in
memory (it came from the model), so only the on-disk side needs bounding — and
it should be async while it is being touched.

### Cheaper alternative, if the above is not worth it

Catch the failure in `edit_file` and say something actionable — "this file is
too large to edit as a whole; it can be read in ranges but not modified" —
rather than surfacing `Invalid string length`. This fixes the confusing message
but none of the memory cost.
