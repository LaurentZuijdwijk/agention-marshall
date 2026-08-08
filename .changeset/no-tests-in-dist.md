---
"@agentionai/marshall-cli": patch
"@agentionai/marshall-engine": patch
"@agentionai/marshall-tools": patch
---

Stop publishing compiled test files.

`files: ["dist"]` ships dist wholesale and the build compiled everything under
`src`, so every release carried its own test suite — 11 compiled test files in
the engine tarball alone, plus their fixtures. Builds now run against a config
that excludes tests, while `typecheck` still covers them.
`@agentionai/marshall-engine/testing` is unaffected: the fake provider is a real
export, not a test.
