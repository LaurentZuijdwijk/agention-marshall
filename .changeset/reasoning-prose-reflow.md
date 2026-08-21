---
"@agentionai/marshall-cli": patch
---

Fix reasoning rendering as a column of single words when a provider breaks its deltas at every
token.

Reasoning is the one text on screen whose line structure the provider decides: it is streamed as
deltas and shown as whatever concatenating them produced. An OpenRouter stealth endpoint
terminated every delta with a newline, and the reasoning block rendered one token per row —
`for` / `a` / `demo` / `).`, forty rows for two sentences, running down the left edge.

Nothing was wrapping it wrongly; the newlines were already in the string, and Ink was drawing
them faithfully. Confirmed by sweeping every wrap width against the reported output: none can
produce it. Below twelve columns Ink hard-breaks long words (`harmless` into `harm`/`less`),
above it short words share a row (`for a`) — and the failure showed neither.

Reasoning is now reflowed for display: a line break inside a paragraph becomes a space, a blank
line stays a paragraph break. That is the rule markdown already uses, and it makes the view
robust to any provider's line-breaking rather than to this one endpoint's. A space is restored
only where the join would otherwise weld two words together, so `smoke` + `-test` and
`expected` + `.` still come out as written. Thinking written as a bulleted list reflows into a
paragraph — accepted, since it is ephemeral and already tail-truncated. Display only: the raw
text still reaches history, so nothing the model sees changes.

Separately, `clampToRows` now counts rows with Ink's own wrapper rather than chopping every
`width` characters. The two disagree — word wrapping packs less into a row — so the live
region's height budget was being counted against a wrap the terminal never performs, and could
overrun the viewport by a row. Small, but `layout.ts` holds only two rows of slack, because Ink
treats a frame that merely equals the viewport as oversized.

This does not address the flicker reported alongside the narrow reasoning. That is still
unexplained: driving the app through the terminal model with budget-filling and per-delta
reasoning, at both 140x42 and 100x24, Ink never took its clear-the-terminal path.
