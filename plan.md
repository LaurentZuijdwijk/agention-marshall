# Plan

## In progress — agentic swarms

The main agent spawns deep or fast agents, each with the full tool set except
the ability to spawn further agents. Barring recursion structurally is what
keeps depth bounded without a budget to police.

### Decisions

- **Scope for safety judging is the agent's own prompt**, not the user's turn
  instruction. A delegated action is in scope if it serves the brief it was
  given.
- **Spawning an agent is itself gated.** That is where the brief gets reviewed,
  which is what makes the decision above safe: consent to the delegation once
  at creation, then judge each action against the brief. Two scope questions,
  each asked once, rather than both on every tool call.
- **Deconfliction is the main agent's job**, up to a point. The file lock
  guarantees safety, not intent — two agents writing one file is a semantic
  conflict the lock can only make survivable.
- Sequential writes remain fine. The goal is that concurrency is never
  *silently* wrong, not that everything runs in parallel.

### Groundwork already landed

All four were real bugs in their own right, not just swarm prerequisites. Each
one made the next visible.

- `f2e0d6c` — writes to one path serialised per path; `write_file` refuses a
  write built on a stale read.
- `d78a5fa` — `write_file` approval renders a diff against disk instead of a
  prefix of the payload. Closes the dodge where rewriting a whole file hid a
  change past the preview cutoff. What is shown now scales with the change, not
  the file.
- `d008dbc` — approval key is tool + caller + arguments, not tool name. A batch
  of writes to different files was costing one prompt, and approving one wrote
  the rest unseen.
- `67f51ff` — `ToolCaller.id` carries the agent *instance*, not just its role.
  Two agents on one role were one actor to the gate, the approval panel and the
  judge.

### Next

1. **Hoist the file lock to session scope.** `createKeyedLock()` currently lives
   inside `createFileTools` (`packages/tools/src/factories/file-tools.ts`), and
   sub-agents get a fresh belt per spawn (`session-tools.ts`, `buildAgentTool`),
   so two writing agents would hold different locks and race. Move it through
   `ToolConfig` the way `readFiles` already is. Mechanical; do it first.
2. **Thread `taskContext` for sub-agents** — set it to the spawn's brief.
   Today it is absent for sub-agents, and safety category O5 says an action with
   no instruction to match against is unscoped, so at level 3 every delegated
   write would be bounced to the human. See the note on `SafetyContext`, which
   already flags this gap.
3. **Gate the spawn.** New approval request at creation carrying the brief, the
   tier and the tool set being granted. Needs a `ToolSource`-style provenance so
   the panel reads as a delegation rather than another file op.
4. **Build the swarm tool.** Full belt minus agent tools, `caller` carrying
   `{ role: 'swarm:<tier>', id: 'swarm:<tier>#n', model }`, and the current
   turn's signal and approval fn pulled through a getter — role tools are built
   at model-switch time, but a writing belt needs per-turn state, and `spawn`
   runs per call so it can read it live.

### Open questions

- A brief that has itself drifted out of scope will not be caught per-action,
  since actions are judged against the brief. The spawn gate is the only thing
  covering that, so the spawn approval has to show the brief plainly.
- Approval volume: N agents × M writes. Safety level 3 is what makes swarms
  tolerable at all, so the two need to ship together in practice.
- Cancellation. `signal` is per turn; spawned agents must die with it, and the
  SDK has no cancellation hook, so the same "abandoned work keeps running
  silently" caveat as the coder applies, times N.
- No token accounting for sub-agents today. `subagent-done` reports duration and
  characters only, which will not be enough to see what a swarm costs.

## Pending

- [ ] Add reasoning effort support — expose the `reasoning` provider field (e.g. OpenRouter `effort` param) in the model config, pass it through the engine client, and include it in the `useEngineClient` message payload. Wire into the model selection UI so the user can set reasoning effort per-model.
- [ ] Run integration tests.
- [ ] Add a `/meme` command as an easter egg.
- [ ] Add agentic coding loops: implement iterative plan → execute → observe → reflect → revise cycles for code changes, with configurable iteration limits, convergence criteria, test/lint/runtime observation collection, reflection prompts, revision handling, progress logging, safety limits, and human approval checkpoints.
  - [ ] Define loop state, iteration, stop reason, and observation types.
  - [ ] Add execution boundaries so each iteration has a scoped task and tool budget.
  - [ ] Run focused tests, lint, and type checks after changes; preserve structured results.
  - [ ] Ask the agent to classify failures as actionable, flaky, environmental, or converged.
  - [ ] Require a human checkpoint before destructive changes, broad refactors, or final submission.
  - [ ] Persist loop progress for resume/cancellation without writing credentials to the workspace.
  - [ ] Add tests for convergence, iteration limits, cancellation, failed checks, and approval denial.
