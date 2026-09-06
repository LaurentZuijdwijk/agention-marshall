---
"@agentionai/marshall-plugin-browser": minor
---

Add `browser_press_key`, and make page reads markdown by default.

`browser_press_key` presses a named key (Enter, Escape, Tab, arrows, Backspace, Delete, Home/End,
Page Up/Down, or a single character) with optional Ctrl/Shift/Alt/Meta modifiers, against a
selector or the currently focused element — covers form submission and dialog dismissal that
`browser_type` alone can't reach.

`browser_read_page` gains a `markdown` format alongside the existing `text`/`html`, and it is now
the default. It keeps structure — headings, lists, bold/italic/code, and links with their `href`
resolved to an absolute URL — at a fraction of `html`'s token cost, so the model can act on a link
without a second `html` read just to find its destination.
