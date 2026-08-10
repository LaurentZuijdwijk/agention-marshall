---
'@agentionai/marshall-cli': patch
---

Fix a startup crash on macOS and Windows caused by two modules whose filenames
differed only in case.

`view/Markdown.tsx` (the React component) sat beside `view/markdown.ts` (the
parser it imports), which built to `Markdown.js` and `markdown.js`. Those are
distinct paths on a case-sensitive filesystem and the same path everywhere else,
so unpacking the tarball wrote one over the other and the surviving module was
missing the export the other's importer asked for.

The component is now `view/MarkdownView.tsx`, exporting `MarkdownView`; the
parser keeps the plain `markdown.ts`.

Two things that let this ship, both fixed as well: nothing tested for the
collision, since it is invisible on Linux where it was built, and `tsc` never
removes stale output — so the rename alone would have left the old `markdown.js`
in `dist` and shipped the collision anyway. Every package's build now clears its
own `dist` first, and a test asserts no two source files differ only by case.
