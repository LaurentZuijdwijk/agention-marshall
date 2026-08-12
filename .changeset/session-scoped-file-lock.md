---
"@agentionai/marshall-engine": patch
"@agentionai/marshall-tools": patch
---

Hoist the per-path write lock to session scope, so every tool belt that can
write queues on the same one.

`createFileTools` owned its lock, which orders only the calls made through that
one belt. That was enough while a single agent did the writing: the belt is
rebuilt each turn, but only one exists at a time. It stops holding as soon as a
second belt can write, because each belt takes its own private lock and the two
serialise against nothing — which is exactly the read-modify-write race the lock
was built to prevent, back where it started and now invisible.

`ToolConfig.fileLock` is injected the same way `readFiles` already is, and for a
reason of the same shape: the lifetime belongs to the session, not the belt.
Absent, the factory still makes its own, which is what the tests and any
single-writer belt want.
