# marshall

A terminal coding agent optimised for **open weights** and local inference. Point it at llama.cpp or
Ollama and the whole loop runs on your own hardware:
no key, no account, no cloud. Nothing is written to disk without your
approval. Cloud providers work too, including Anthropic, OpenAI and
OpenAI-compatible providers.

```
npm install -g @agentionai/marshall-cli
marshall
```

Node 22+. If `llama-server` or `ollama` is already running, marshall finds it
during the thirty-second setup wizard: no account, no API key required.

## Open weights first

Most coding agents bolt local inference on as a downgrade path. Marshall is
designed around it: **llama.cpp and Ollama are first-class providers** and sit
at the top of the setup wizard.

- **No key, no account, no cloud.** `marshall --provider llamacpp` and you're
  working. No telemetry, no vendor who can deprecate your model out from under
  you. The only network call that leaves your machine is a version check
  against the npm registry.
- **It knows what's actually loaded.** The model picker reads llama.cpp's
  router and Ollama's `/api/ps` for live state: which models are resident
  right now, the real runtime context vs. what a preset merely asks for, the
  trained ceiling, quant and file size. Loaded models sort first, so you don't
  eat a cold reload mid-task.
- **Written for small context windows.** Rolling compression with pinned
  goals, tool-result masking and read dedup keep a session inside a modest
  window. Local servers also get an output ceiling, since without one they'll
  happily generate until the window is gone.
- **Mix local and paid, per role.** `deep` and `fast` are full profiles, each
  with its own provider, host and key. Put a frontier model on `deep`
  (planning, coding, review) and a local one on `fast` (reading files,
  searching, summarising history): the bulk of the tokens never leave your
  machine or hit your bill, and you pay only for the reasoning. Or run both
  local, on two different servers. See `/model deep`, `/model fast`, `/model
  off` below.

## How it works

Not a single autocomplete on steroids: three agents in a feedback loop, all
running on the `deep` tier.

1. **planner** turns "add rate limiting to the API" into an ordered,
   concrete plan.
2. **coder** reads, edits and runs your project with a safe tool belt;
   every write and shell command is gated behind an approval you can audit.
3. **reviewer** gives a second opinion on the actual diff, and loops with the
   coder until it holds up. It never rubber-stamps.

Everything around the three agents (fetching context, searching, compressing
history) runs on `fast`. That's the seam the two tiers are cut along, and
it's why pointing `fast` at a local model takes most of the token volume off a
paid API without touching the quality of the decisions.

## Providers

The setup wizard leads with the three it can query live: **llama.cpp**,
**Ollama** and **OpenRouter**. Frontier labs like Anthropic and OpenAI are
there too.

Hosted names are there when you want them, never assumed, and nothing
stops you pairing two vendors: one on `deep`, another on `fast`. Switch any
time with `/model`.

| Provider | Notes |
|---|---|
| `llamacpp` | local · no key · probes what's loaded |
| `ollama` | local · no key · resident models first |
| any OpenAI-compatible server | vLLM, SGLang, LM Studio, TabbyAPI, an internal gateway; point `--host` at it |
| `openrouter` | live catalogue, filtered to models that actually support tool calling; `:free` variants sorted first |
| `claude` | `ANTHROPIC_API_KEY`, or `/login` |
| `openai` | `OPENAI_API_KEY` |
| `gemini` | `GEMINI_API_KEY` |
| `mistral` | `MISTRAL_API_KEY` |
| `cerebras` | `CEREBRAS_API_KEY` |

No GPU at home? OpenRouter is the next best thing. The ~340-entry catalogue
is filtered down to models that can actually call tools (DeepSeek, Qwen, Kimi,
GLM, MiniMax, Llama, Mistral alongside the hosted frontier names), with
`:free` variants sorted to the top so trying a new open-weight release costs
nothing.

## Why marshall

- **Approval for every mutation.** `write_file`, `edit_file` and `run_shell`
  render their diff or command before they run. Approve once, always-allow
  for the session, or deny; `esc` denies everything pending.
- **Interrupt & steer.** `esc` stops at the next safe boundary (writes are
  atomic, so nothing is left half-written) and your next message
  course-corrects instead of restarting.
- **Sandboxed tools.** File tools are hard-jailed to the workspace (`..`
  traversal and escaping symlinks are rejected); shell runs with a scrubbed
  environment, timeouts, output caps and a configurable command policy.
- **Project memory.** An `AGENTS.md` file in your workspace holds
  conventions, architecture notes and prior decisions, loaded into the
  system prompt at session start.
- **Knows your repo's paperwork.** Built-in GitHub tools read issues, pull
  requests and diffs, leave comments, and open a PR when the work is done.
- **Headless engine.** The terminal is one client over a stdio JSON-RPC
  transport; nothing about the engine assumes a terminal exists.

## Commands

Run `/help` in a session for the full, current list. As of this version:

| Command | Description |
|---|---|
| `/model` | pick deep + fast models; lists OpenRouter's live catalogue or probes local servers for what's actually loaded |
| `/model deep` / `/model fast` / `/model off` | change one tier, or stop tiering entirely |
| `/plan <task>` | get a plan before touching code, carried as context into your next task |
| `/review [notes]` | second opinion on the current workspace state |
| `/memory` | view `AGENTS.md`, the project memory loaded at session start |
| `/login` | authenticate with a Claude account instead of an API key |
| `/tokens` | toggle usage (↑ in / ↓ out / time) after each response |
| `/stream` | toggle live token streaming vs. final response only |
| `/clear` | reset history, dedupe cache and scratch notes |
| `/cwd` | show the current workspace root |
| `/exit` | quit |

| Key | Description |
|---|---|
| `Esc` | interrupt the running task, enter steering mode |
| `Esc Esc` | force-quit |
| `Esc` (during an approval prompt) | deny everything pending and interrupt |
| `Ctrl-R` | toggle live reasoning, on providers that stream chain-of-thought |
| `Ctrl-V` | attach the image on your clipboard to the next message |
| `Ctrl-C` / `Ctrl-C Ctrl-C` | interrupt (or quit if idle) / force-quit |

## Configuration

Credentials and provider/model settings live in a global config, created on
first run at `~/.config/marshall/config.json` (or
`$XDG_CONFIG_HOME/marshall/config.json`). The setup wizard writes to this file
whenever you switch providers or models.

A project can optionally check in its own `.marshall/config.json` at the
workspace root. If present, it's deep-merged on top of the global config,
and project values win. This lets a repo pin its own model/provider without
touching your global credentials.

> **If `.marshall/config.json` is committed to a shared or public repo, don't
> put a bare API key in it.** Reference an environment variable instead (or
> omit `apiKey` entirely and rely on the provider's default env var), or a
> future contributor's secret ends up committed for everyone.

Session logs (`.marshall/logs/`) and task-scratch notes (`.marshall/notes/`)
stay project-local: they're working state for a given checkout, not
credentials.

See `marshall --help` for the full flag reference (provider/model overrides,
fast-tier flags, per-role model pins, GitHub tools, web search, max tokens).

## Fine print

- **The sandbox is containment, not a security boundary.** File tools are
  hard-jailed to the workspace, and shell runs under a command policy, but a
  shell command can still reach the network, or read a file outside the
  workspace by absolute path. OS-level isolation (container/microVM) is
  planned; only the executor behind the tool would change.
- **A local model still has to be good at tool calling.** Marshall gives
  every provider the same tool belt, but the model decides whether it uses it
  well. The OpenRouter picker filters to models that advertise tool support;
  for a local server, that's on you to pick. Some capabilities are
  hosted-only: web search rides Anthropic's server-side tool, and Ollama
  silently drops images, so marshall refuses an image attachment there rather
  than answering about something the model never saw.
- **One workspace, one terminal.** No multi-repo sessions, and no editor
  integration yet.

## Links

- Site: https://marshall.agention.ai
- Source: https://github.com/LaurentZuijdwijk/agention-marshall
