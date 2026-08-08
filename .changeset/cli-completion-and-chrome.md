---
"@agentionai/marshall-cli": minor
---

Complete slash command arguments, not just command names.

Tab stopped working the moment you typed a space, so the argument words for
`/model`, `/safety`, `/jobs` and `/mcp` were invisible unless you already knew
them. `/model ` now offers `deep`, `/safety ag` finishes `agentic`, and verbs
that still need a value (`/mcp remove`, `/jobs kill`) complete with a trailing
space so the cursor lands where the name goes. The word list lives beside the
parser and is tested against it, so completion cannot offer something the parser
would reject.

Also: a tagline under the wordmark, and safety verdict rows now stay on one line
instead of wrapping and losing the gutter that marks them as commentary on the
call above.
