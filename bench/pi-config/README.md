# Bench-owned `pi` config

Points `pi` at the same local llama.cpp router the marshall configs use, so a
`pi` row and a marshall row in the same results table are running the same
model on the same server.

Selected with `PI_CODING_AGENT_DIR=<this dir>`, which keeps `~/.pi` untouched —
the bench must not depend on, or modify, whatever the machine's own `pi` setup
happens to be.

`pi` does not enumerate the router: `pi --provider llama-cpp --list-models`
against the default config lists only what is pinned in `models.json` plus the
literal `llama-cpp-discover` entry, so the model has to be named explicitly here.

Two fields are load-bearing:

- `contextWindow` (**not** `contextLength` — that name is silently ignored and
  you get the 128000 default) is set to the server's real `n_ctx_slot` of
  262144, so `pi` and marshall are working against the same physical window.
  Each harness still applies its own compaction policy well below that, which is
  a difference between the products and is left alone.
- `maxTokens` matches `BENCH_ENGINE_DEFAULTS.maxTokens`, so neither side gets a
  larger output budget than the other.
