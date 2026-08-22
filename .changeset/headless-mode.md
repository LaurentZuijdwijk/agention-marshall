---
"@agentionai/marshall-cli": minor
---

Add `--message`/`--safety` for running one task non-interactively and exiting — no Ink, no
REPL — for scripting and benchmark harnesses (built for the Harbor/Terminal-Bench agent
adapter under `bench/harbor_agent/`). `--message <task>` requires `--safety yolo`, since
headless mode has no human to fall back on and the other two levels both still end in "ask a
human." Output is a plain-text transcript on stdout, plus a `MARSHALL_USAGE` marker line with
final token/cost totals (turn and session, `reasoningTokens` broken out where the provider
reports it) once the turn ends. Exit code reflects the run: 1 on any engine error or
interruption, 0 otherwise.
