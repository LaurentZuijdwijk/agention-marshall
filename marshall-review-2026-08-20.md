# Review of uncommitted changes

## Scope
29 modified files, 31 untracked files. No staged changes. Branch: `main` (up to date with `origin/main`), last commit `504c369 chore: version marshall-cli@0.21.2`.

The diff is coherent — it is **one release's worth of work**, not a random pile. The eight `.changeset/` entries, the `packages/tools/TODO.md`, `docs/competitive-findings.md`, `bench/README.md`, and the new `packages/tools/src/factories/file/` directory all point the same direction: a tools-layer hardening pass plus prompt-caching/cost fixes in the engine, with a benchmark harness extension on the side.

---

## The changeset set — what this release is trying to ship

1. **`.changeset/fix-read-file-line-counts.md`** — `@agentionai/marshall-tools`, patch. The biggest structural change in the diff: `read_file` and `search` move from slurping whole files to streaming. This is the spine everything else hangs off.

2. **`.changeset/fix-read-file-oversized-line.md`** — `@agentionai/marshall-tools`, patch. The single-line-cap bug. Directly addresses a real defect where a 480 KB one-line file bypassed the byte cap and got a request rejected by the model.

3. **`.changeset/search-quality.md`** — both packages, patch. Four search defects: truncation-notice-as-content, binary files, oversized matched line, generated-directory skip list widened to directories only.

4. **`.changeset/list-dir-file-sizes.md`** — `@agentionai/marshall-tools`, patch. `list_dir` reports file sizes. Small but turns the file-size question answerable before the read is spent.

5. **`.changeset/fix-tool-call-pairing-compression.md`** — `@agentionai/marshall-engine`, patch. The compression/tool-call-pairing fix. This is the second-biggest change in the engine diff.

6. **`.changeset/live-openrouter-cost.md`** — `@agentionai/marshall-engine`, patch. Provider-reported `cost_usd` now flows through to the usage tally. Fixes the "cost shows as `-` for sonnet-5" problem.

7. **`.changeset/trim-tool-descriptions.md`** — `@agentionai/marshall-tools`, patch. Wording-only. Low risk.

8. **`.changeset/model-picker-search-and-safety.md`** — `@agentionai/marshall-cli` minor + `@agentionai/marshall-engine` minor. Model picker search + OpenRouter content-safety models. Cross-package minor; touches CLI code that is not in this diff's file set in any depth.

The first five are the load-bearing ones. The last three are thinner and lower risk, except the CLI piece which I could not fully review from this diff alone.

---

## Positive findings

### Streaming read path is the right fix, and it is tested at the right level

`packages/tools/src/primitives/line-window.ts` is the new primitive. It streams via `createReadStream`, holds only the requested window, and still reports `totalLines`, `byteLength`, and a whole-file SHA-256. The design intent is stated plainly in the doc comments: memory is bounded by `maxBytes`, not by file size.

The test file `packages/tools/src/primitives/line-window.test.ts` is good. The cases that matter most are present and explicit:
- trailing-newline line counting matches `wc -l`/`grep` semantics
- CRLF is preserved (not stripped), with a test asserting `alpha\r` is what comes back
- single oversized line is clipped to `maxBytes`, with a 500 KB one-line file test
- `startLine` landing on an oversized line clips the same way
- multi-byte character split across a chunk boundary survives
- long line spanning many chunks is assembled whole
- hash and byte length describe the whole file even for a windowed read
- invalid UTF-8 does not change the hash (bytes hashed, not lossy decode)
- `splitLines` and `readLineWindow` are held to agree with each other

That last point is the kind of guard that prevents the two implementations from drifting. Worth keeping.

`packages/tools/src/primitives/capped-read.ts` is still present and still used by `search` and `scratch-tools`. The comment explaining why `search` uses `cappedReadPart` rather than `cappedRead` is correct and important: the truncation marker is indistinguishable from file content once it is in a string, so a search over it can report a match at a line number the file does not have. The code respects that.

### The read gate is now correct about what "read" means

`packages/tools/src/factories/file/read-gate.ts` is where `read_file`/`write_file`/`edit_file` share state. The new `ReadCoverage` type (`'complete' | 'range' | 'over-limit'`) is a clean way to express the permission model:
- `write_file` now refuses after a ranged read and names the reason
- `write_file` refuses after an over-limit read and names `maxFileBytes` as the fix
- `edit_file` no longer promotes a ranged read to `'complete'` — matching a unique substring is not reading the file

The tests in `read-gate.test.ts` cover the permission edges directly:
- ranged read then write is refused, with the right reason and no mention of `maxFileBytes` when the file is small
- edit after ranged read stays a ranged read; the unseen tail is still intact
- edit after full read still allows a later `write_file`
- over-limit read then write is refused with the `maxFileBytes` wording
- parallel edits to one file all land (the keyed lock does its job)
- two `write_file` calls for one path in a batch: the second is rejected with "changed after you read it", not silently applied
- external change between read and write is refused
- injected session-level lock serialises two belts writing one file

That last test (`an injected lock serialises two belts writing one file`) is the confirmation that the session-scoped lock is actually wired, not just present. Good.

The `describeWrite` change is security-relevant and done right. The old version showed the first 800 characters of the new content, which meant a change past that point was never displayed; the reviewer saw an unchanged benign prefix and approved a change they were never shown. The new version diffs against what is on disk, with context-window truncation that is safe because what gets cut is further *changes* and the reader is told how many. A short diff means a small change, never a hidden one. The doc comment in `diff.ts` states this property explicitly.

### Search defects are fixed with the right shape

`packages/tools/src/factories/file/search.ts`:
- binary detection uses `cappedReadPart`'s `binary` flag (NUL byte), skips, and reports how many were skipped
- truncation notice no longer pollutes content; `cappedReadPart` used explicitly
- matched line is clipped to a window centred on the match, with `…` markers on both sides, capped at 400 characters
- generated directories skip list widened and now applied only to directories, so a file named `build` or `vendor` is still searched
- says when a file was only read up to its per-file cap, including on "no matches"
- `fileGlob` that matches no files says so instead of "no matches"

The search tests are concrete and adversarial:
- `big.log` with "needle" past the cap: words that appear only in the marker (`truncated`, `exceeds`, `read limit`) must not be reported as a line of the file
- `bundle.min.js` with a match buried in 60 KB of filler: one hit must be under 1000 characters and contain the match and a `…`
- binary file test checks no raw bytes reach the result
- `fileGlob: 'src/*.ts'` with no matching files returns "No files matched fileGlob" rather than "No matches found"

These are exactly the shapes that broke the competing tools according to `docs/competitive-findings.md`. The test intent is aligned with the real failure mode.

### Tool-call pairing fix is thorough and well-tested

`packages/engine/src/session-compression.ts`:
- `toolPairing` tracks calls, answered calls, and orphaned results, and treats ordering as significant (a result before its call is as invalid as a missing call)
- `firstCleanTailStart` moves the compression boundary to the nearest place that does not cut a call away from its result
- `middleCompressionPlugin.reduce` now checks the repaired output for orphaned results or an increased dangling count and skips rather than emitting a history the provider rejects

The test file `session-compression.test.ts` covers:
- across a sweep of budgets, no budget strands a tool result
- the pair is kept together or summarised together, never half
- a budget with room for the whole pair keeps both
- compression is skipped rather than emitting a broken history when `first` is a call whose result is in the middle

The integration test in `session-lifecycle.test.ts` ("a tool result stranded from its call is repaired before the next request") confirms the repair path works end-to-end: a session carrying a broken pairing heals rather than failing every turn.

The error-classification work in `errors.ts` is the right companion. `classifyProviderError` is now one function with an explicit ordering and a reason string, and the session log emits `kind=`, `because=`, `COMPRESSION_TRIGGERED_BY_ERROR`, `NO_COMPRESSION`. The new `isUnsupportedRequestError` catches content-filter rejections, invalid schemas, unsupported parameters, image decode failures, etc., and reports them instead of spending a compression pass and handing back a full context window.

The tests in `errors.test.ts` and `session-lifecycle.test.ts` pin the boundary cases:
- content-filter rejection is reported, not compressed
- rejected tool schema is reported, not compressed
- unlabelled 400 is still treated as a possible overflow (the llama.cpp recovery path must stay)
- a provider that names the context window is compressed for

This is the right balance: remove the misdiagnoses without removing the one recovery path that exists because some providers report an overflow with no wording at all.

### Dangling tool call repair is improved

`packages/engine/src/session.ts`:
- `repairDanglingToolCalls` now groups unanswered calls by the entry that made them and inserts the cancellation result directly after each one, not at the end of history. This is what makes a break inherited from mid-conversation actually heal.
- `dropOrphanedToolResults` removes orphaned result blocks without dropping the surrounding assistant text, and preserves entry metadata so a compression summary keeps its `isSummary`/`coversRange`/`date`
- `SessionHistory` exists specifically to give the repair paths a metadata-preserving rewrite path; the doc comment explains why the naive `entries → clear → addEntry` route destroys summary metadata

The tests confirm:
- dropping an orphaned tool result keeps a compression summary recognisable (summary flag, coversRange, date all survive)
- a dangling tool call mid-history is answered next to the call, not at the end
- the repair is idempotent on an already-healthy history

### Cost tracking now uses provider-reported values

`packages/engine/src/usage.ts`:
- `TokenCount.costUsd` and `UsageTotals.costUsd` exist
- `createUsageTally.record` prefers `usage.costUsd` when present, falls back to the price table
- `total()` distinguishes "nothing priced" (no cost figure at all) from "$0" (known-free local provider) from "$0 or more" (partial pricing)
- `costPartial` flag when some entries had no price

`packages/engine/src/session.ts` and `packages/engine/src/session-tools.ts` now pass `costUsd` through from `lastTokenUsage` when present, for the coder agent and for sub-agent calls.

The tests in `usage.test.ts` cover the important edges:
- provider-reported cost is preferred over the price table
- a live cost of exactly zero still counts as priced, not missing
- partial pricing is flagged, exact tokens still reported
- free local provider is a known zero, not an unknown
- nothing priced produces no cost figure at all (not `$0.00`, which would read as free)

This fixes the concrete problem described in `docs/competitive-findings.md` and `.changeset/live-openrouter-cost.md`: `anthropic/claude-sonnet-5` used to show cost as `-` because it was not in the local catalogue, even though OpenRouter returns the real cost on every response.

### Prompt caching is wired for the long-lived coder agent

`packages/engine/src/agent-factory.ts`:
- `CreateAgentOptions` gains `promptCaching` and `sessionId`
- the `openrouter` branch passes them through to `OpenRouterAgent`

`packages/engine/src/session.ts`:
- the coder agent is created with `promptCaching: true` and a stable `sessionId` (`randomUUID()` generated once per session)
- the comment explains why sub-agents and the compression summariser leave this off (they are short-lived and would not earn back the cache-write cost)

`docs/competitive-findings.md` reports the measured effect: ~10x cheaper from the second turn on for the same session, with real numbers (turn 1 cache write 3,746 tok/$0.00955; turns 2–3 cache read 3,746 tok/$0.00096 and $0.00098).

The `sessionId` field is the precondition for the cache actually hitting rather than writing a cache that never gets read; without it, OpenRouter can load-balance consecutive requests to a different upstream instance. The code generates it once and holds it for the session, which is correct.

### `agentTool` now carries cost through

`packages/engine/src/agent-tool.ts`:
- `AgentTokenUsage` is a `Pick<TokenUsage, 'input_tokens' | 'output_tokens' | 'cost_usd'>`, with a doc comment explaining why `cost_usd` earns its place (it is the only figure for a sub-agent on a model missing from the catalogue)
- `Executable.lastTokenUsage` and `onEnd.usage` use the narrowed type

`packages/engine/src/agent-tool.test.ts` adds a test that a provider-reported cost reaches `onEnd` alongside the token counts.

This is the seam that lets the sub-agent cost flow reach the tally. It was presumably the point of the earlier bug where cost went missing.

### Bench harness extension is reasonable

`bench/config.ts` adds:
- `light?: boolean` to `BenchConfiguration`
- `sonnet5-openrouter` and `sonnet5-openrouter-light` rows, with a clear comment that they are the same model as the external harnesses for a fair same-model comparison
- `ling3-flash` row as a cheap hosted smoke runner, with an honest comment that it is not a competitive comparison stand-in
- `EXTERNAL_HARNESSES` with `pi` and `opencode` rows, opt-in only

`bench/tasks.ts`:
- `BenchTask.check` signature gains `response: string`, with a clear explanation that Q&A tasks check the agent's final message and code-editing tasks ignore it and run real tests
- `answerContains` helper for deterministic Q&A checks
- `qa-large-log` and `qa-minified-token` tasks, with comments tying them to the adversarial fixtures and to `docs/competitive-findings.md`

`bench/run.ts`:
- `RunResult` gains `costUsd`
- `makeClient` captures `session.costUsd` from the final usage event
- `runOneExternal` wired up for the external harnesses
- results written to `results.json`

`bench/results.json` contains real results from the `ling3-flash` config across the tasks. The failures are honest and well-explained: `ling-3.0-flash` reports "target label not found" on some calls, and one `refactor` trial failed because the model did not rename the function correctly. These are the right failure modes to see, and they are recorded with enough detail to diagnose.

`bench/external-harness.ts` is a clean, documented shim for running `pi` and `opencode` through the same tasks. The PTY workaround for the "hangs without a TTY" problem is explained in the doc comment, with the Linux/`script` limitation called out. The `pi` parser sums `input + cacheRead + cacheWrite` deliberately, with a comment explaining why reporting only `input` would understate a warm-cache turn.

The new `bench/README.md` is good documentation: methodology, where it falls short, how to run it, env vars, how to add a task, and how to regenerate the `real-repo-fix` fixture.

### Tool description trim is low-risk

`.changeset/trim-tool-descriptions.md` is wording-only. The descriptions of `list_dir` and `search` are shorter. No behavior change claimed, and none visible in the code I read.

---

## Risks and things to double-check before merging

### 1. The deleted `file-tools.ts` / `file-tools.test.ts` need to be fully replaced

`git status` shows:
- deleted: `packages/tools/src/factories/file-tools.test.ts`
- deleted: `packages/tools/src/factories/file-tools.ts`

And in the diff, `packages/tools/src/index.ts` now exports from `'./factories/file/index.js'` instead. So the old monolithic file has been split into `packages/tools/src/factories/file/`.

I read `index.ts`, `read-gate.ts`, `list-dir.ts`, `search.ts` and their tests. They look complete and correct. But I did not read every line of `read-gate.ts`'s `describeWrite` diff integration with `formatFileDiff`/`describeDiff` end-to-end with a real approval flow, and I did not confirm there is no leftover reference to the old file name anywhere else in the tree (the diff only covered the packages in scope). Before merging, grep the codebase for any remaining reference to `file-tools` as a module path, and run the tools test suite.

### 2. The CLI-side changeset is not fully reviewable from this diff

`.changeset/model-picker-search-and-safety.md` lists `@agentionai/marshall-cli` as a minor. The diff I have is focused on `packages/engine` and `packages/tools`. I did not read CLI code, so I cannot confirm the model-picker search and content-safety catalogue changes are actually present and correct in this commit. If that changeset is intended to ship with this set, the CLI changes need to be in the diff and reviewed. If they are already committed elsewhere or are a separate branch, the changeset should not be bundled here.

### 3. `read_file`'s truncation notice wording now depends on `lineClipped` vs `truncated`

In `read-gate.ts`, the truncation notice now has three branches:
- `lineClipped`: "line N truncated — it exceeds the read limit on its own..."
- `truncated` (but not lineClipped): "file truncated — showing lines A–B of T..."
- otherwise: ''

This is better than before. The one thing to verify: when `startLine` is set and the *window* starts on an oversized line, `lineClipped` is true and the notice says the line exceeds the limit on its own. When `startLine` is set and the window ends before the file's end but no single line was clipped, it should say "file truncated — showing lines...". The `line-window` tests cover the clipping cases; the read-gate tests cover rendering. I would run the full file-tool test suite to be sure the two are wired together as expected in every combination, especially `startLine` + oversized first-line-of-window.

### 4. `search`'s per-file cap and `read_file`'s `maxFileBytes` are now different numbers

`search.ts` uses `MAX_SEARCH_FILE_BYTES = 256 * 1024`. `capped-read.ts` default is `256 * 1024`. `read_file` uses `maxFileBytes` from config, defaulting to `DEFAULT_MAX_FILE_BYTES` (256 KiB). So they are the same default, but `search` has its own constant. That is fine and probably deliberate (search is capped internally; read_file is configurable). Just confirming there is no expectation that they are the same tunable. If someone raises `maxFileBytes` for read_file, search does not follow. That is the correct behavior given the different purposes, but worth stating explicitly in a comment if it is not already.

I read `search.ts` and `capped-read.ts`; `search` caps each file at its own constant and says so in the note. No inconsistency.

### 5. `results.json` contains real API calls' cost and token data

`bench/results.json` has `costUsd` values and token counts from actual OpenRouter runs against `inclusionai/ling-3.0-flash`. This is fine to commit if the repo's policy allows benchmark results, but note it includes real spend. If this repo is public or shared, consider whether `results.json` should be in `.gitignore` or kept out of the committed set. The file is currently untracked and not staged, so this is a decision for when it is added.

### 6. `bench/run.ts` calls `process.exit(0)` at the end

The comment explains why: `script` leaves something in the event loop. This is a pragmatic exit. It is fine for a bench script, but worth knowing it is there if anyone tries to integrate the harness into a longer-running process.

### 7. The external harness PTY workaround is Linux-only

`external-harness.ts` uses `script -qec ... /dev/null`. The README calls this out as Linux-specific and says BSD/macOS `script` takes different flags. If this bench is meant to be run cross-platform, that is a known gap. If it is run only on Linux, it is fine.

### 8. `qa-large-log` task's check is `answerContains(/\bno\b/i)`

This asserts the answer contains the word "no". The task prompt asks "Does this codebase contain the word 'exceeds' anywhere? If so, in which file and on what line?" The correct answer is "no". The check is just `answerContains(/\bno\b/i)`, which passes if the agent says "no" anywhere. That is a bit loose — an agent could say "no, but..." and pass, or embed "no" in a different context. It is probably good enough as a regression guard, but if the goal is a strict Q&A verifier, a second pattern checking that the answer does not claim a file/line for "exceeds" would be tighter. Not a blocker; worth noting.

### 9. `classifyProviderError` order and the `isBadRequestError` fallback

`errors.ts` classifies in this order: connection, rate-limit, context-length, model-not-found, dangling-tool-call, unsupported-request, then `isBadRequestError` → `maybe-context`, else `other`.

The comment says connection and rate-limit come first because `isBadRequestError` reads any `400` in the message text and a quota payload can contain one. I read `isBadRequestError` — it walks `err`/`cause` depth up to 5 and checks `statusCode`/`status`/message for `400`. So a rate-limit error whose payload happens to contain "400" somewhere could theoretically be misclassified if the rate-limit check did not fire first. The order handles that. Good. The one remaining guess is `maybe-context` for any unlabelled 400; the code and tests are honest about that being a guess that must stay for llama.cpp. This is the right design.

### 10. `SessionHistory` reaches into `protected _entries`

`session-history.ts` assigns to `this._entries` directly in `replaceEntries`, deliberately skipping `addEntry` side effects. The doc comment explains why: re-adding N entries one at a time would fire N `afterAdd` hooks and kick off N reduces. This is a deliberate subtype breach of the base class's intended usage. It is reasonable, and the comment is clear, but it is a dependency on an implementation detail of `History`. If the upstream `@agentionai/agents` package changes `_entries` or the hook semantics, this breaks. Worth keeping an eye on, and possibly wrapping the assignment in a feature-flag or guarded access if the SDK ever formalises a replacement. Not a current blocker.

---

## What I did not fully review

- Any CLI code referenced by `.changeset/model-picker-search-and-safety.md`. I could not confirm that change is in this diff.
- The full `read-gate.ts` `describeWrite` path with a real approval UI round-trip. I read the code and the test that asserts the buried change appears in `request.detail`, which is strong, but I did not run it.
- Any integration beyond what is in the diff's test files. The unit and integration tests are excellent; I did not run them.
- Whether `results.json` should be committed at all, given it contains real spend.

---

## Overall assessment

This is a strong, coherent changeset. The two central fixes — streaming reads / line-window capping, and tool-call-pairing-aware compression — are the right answers to real, reproduced defects, and they are backed by tests that target the exact failure modes rather than just the happy path. The cost and prompt-caching fixes are straightforward and well-tested. The bench harness extension is clean and honestly documented about its limitations.

The main things to resolve before merging:
1. Confirm the CLI changeset has its code in this diff, or separate it.
2. Confirm no stale references to the deleted `file-tools.ts` remain anywhere in the repo.
3. Decide whether `bench/results.json` should be tracked.
4. Run the full test suites for `packages/tools` and `packages/engine`, and ideally a small bench run, to confirm the wiring between `line-window`, `capped-read`, `read-gate`, `search`, and the read-gate permission model holds in every combination.

If those four are clear, the changes look mergeable.
