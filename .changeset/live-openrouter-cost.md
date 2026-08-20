---
"@agentionai/marshall-engine": patch
---

Session cost tracking now uses the actual USD OpenRouter billed for each call, when the
provider reports it, instead of only a local price-table lookup.

The price table has no entry for every model OpenRouter routes to, so `costUsd` used to read as
`-` for any model outside the catalogue — `anthropic/claude-sonnet-5` among them. OpenRouter
already returns the real cost on `usage.cost` for both streaming and non-streaming responses;
this reads that value straight off the response and prefers it over the price-table estimate,
falling back to the table only when a provider doesn't report its own cost.

Sub-agent calls (`context`, `search`, `planner`, `reviewer`, and spawned agents) report their cost
the same way. They previously passed only token counts through to the tally, so a delegated call
on a model outside the price table contributed nothing at all and left the session total flagged
as partial.
