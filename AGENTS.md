# Project memory

Loaded into the system prompt at the start of every session. Keep it short —
everything here is paid for on every turn.

## Credentials never go in a project-local file

There are two config files, and the split is a security boundary, not a
convenience:

| | Path | Committable | May hold secrets |
|---|---|---|---|
| global | `~/.config/marshall/config.json` (`$XDG_CONFIG_HOME` honoured), mode `0600` | no | **yes** |
| project | `<workspace>/.marshall/config.json` | **yes — assume it is committed** | **no** |

The project file exists so a repo can say *which* things it uses. It must never
be able to say *what the credential is*. A token committed there leaks to
everyone who clones the repo, and to anyone reading the history afterwards —
rotating it later does not undo that.

**When adding any new config surface that can carry a credential:**

1. Put the definition, including the secret, in the **global** file.
2. Give the project file a *selection* key only — names, flags, enable/disable
   lists. Never a place to write a value that could be a secret.
3. If the project file can also declare items of that kind, **strip the
   credential fields when reading** rather than trusting the file not to have
   them. `resolveMcpServers` in `apps/cli/src/services/config-store.ts` is the
   reference implementation: a project-declared MCP server keeps its `url` and
   loses its `headers`, so a no-auth localhost server still works and a leaked
   token is simply ignored.
4. Cover the stripping with a test. The rule is only real if it fails loudly.

Use a *separate key* for the project-side selection, never the same key as the
global definition. `loadConfig` deep-merges the two files and replaces arrays
wholesale, so reusing the key would make a project file silently replace the
global list — which forces every secret to be repeated in the committed file to
keep the other entries working. That is how this goes wrong quietly.

Same rule for anything written at runtime: OAuth tokens, refresh tokens, API
keys and PKCE verifiers belong in the global config or `~/.marshall/`, at
`0600`. Never in the workspace, and never in `.marshall/` inside it.
