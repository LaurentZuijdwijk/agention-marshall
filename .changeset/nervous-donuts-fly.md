---
'@agentionai/marshall-engine': patch
---

Fix reasoning-model agents failing with "Response incomplete: max_output_tokens".
The engine omits the output cap for hosted OpenAI so the model's own ceiling
applies, but the installed agents SDK falls back to 1024 when the field is
missing — and a gpt-5/o-series model spends those 1024 output tokens reasoning,
then emits no visible text and errors. Reasoning models now get a real default
output cap (8192). Reasoning-model detection is prefix-tolerant, so it also
covers OpenRouter ids like `openai/gpt-5.6-luna`.