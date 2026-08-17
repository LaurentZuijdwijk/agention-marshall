---
'@agentionai/marshall-engine': patch
---

Fix a turn interrupted mid-tool-call (during approval or execution) leaving
an unanswered tool call in history. A provider that requires every call to be
answered rejected the *next* request outright ("No tool output found for
function call ..."), and because that 400 carried no context-length wording,
it was misread as context overflow and sent through a compression pass that
could never fix it. Interrupting now patches the dangling call with a
synthetic cancelled result before the next turn can see it, and the
misdiagnosis is closed off directly with a classifier that recognises this
error shape instead of guessing.
