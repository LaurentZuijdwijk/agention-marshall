---
'@agentionai/marshall-cli': minor
---

Show the update notice in the session instead of after it.

The startup check ran, found a newer release, and then printed it to stderr *after* Ink had
exited — into a terminal nobody is looking at any more. It now arrives as a transcript row
that says what to do: `update available: 0.8.2 → 0.9.0 — type /update to install`.

The row is held until the boot animation finishes, because the banner's `onDone` replaces
the transcript wholesale; a row pushed while it was still animating was discarded. Since the
check is a network round trip racing an animation, which one won was luck, and losing meant
the notice silently never appeared.

`checkForUpdate` now resolves to `{ current, latest }` rather than a pre-formatted string,
so the two callers can each say the right thing — the startup row points at `/update`, while
`/update` is already installing. When a global install fails (a root-owned prefix, usually)
`/update` now hands over the `npm install -g` command instead of only reporting the error.
