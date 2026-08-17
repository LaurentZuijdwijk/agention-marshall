---
'@agentionai/marshall-engine': patch
---

Raise the default safety-judge output cap from 1200 to 4096 tokens. Local
hybrid-thinking GGUF models (and other reasoning-tuned judges) can emit a
chain-of-thought preamble well past 1200 tokens before their verdict, which
threw `MaxTokensExceededError` instead of ever producing a decision.
`safetyAgent.maxOutputTokens` still overrides this per judge for models that
need more.
