---
'@agentionai/marshall-engine': patch
---

Fix the safety judge crashing against gpt-5/o-series reasoning models: `temperature` is omitted for reasoning-model profiles instead of being sent as `0`, which those models reject with a 400. Temperature handling on plain chat models is unchanged.