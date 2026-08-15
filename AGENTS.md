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

`saveProfiles` (`/model`, the setup wizard) is the reference implementation:
`withModelSelection` writes which model/provider each tier uses to the
*project* file, credential-free, so the choice is local to this workspace
instead of following the user to every other repo; `withProviderCredentials`
writes the host and key that make it reachable to the *global* file, since
that's the same wherever marshall runs. Both in `config-store.ts`.

Same rule for anything written at runtime: OAuth tokens, refresh tokens, API
keys and PKCE verifiers belong in the global config or `~/.marshall/`, at
`0600`. Never in the workspace, and never in `.marshall/` inside it.

## One way to read and write config

`ConfigService` (`apps/cli/src/services/config-service.ts`) owns both files.
Disk is the source of truth: it caches a snapshot only until the next write, and
every write re-reads the file it is about to change. `write()` is the single
place that opens a config file for writing — it queues, sets the mode, and
notifies subscribers. Add a mutation as a transform passed to it.

Do not add a second writer, and do not mirror config in React state. Five
independent read-modify-write functions, plus copies of their data in props,
is what made a removed provider stay on screen and a removed MCP server come
back on the next launch.

## A patched dependency: ink's text wrap

`patches/ink+7.1.1.patch` (applied by `patch-package` via the root
`postinstall` script) fixes a real bug in `ink`'s default text wrap: it calls
`wrap-ansi` with `trim: false`, which leaves a stray leading space on whatever
wrapped line happens to start right after a word landed exactly on the column
boundary — a ragged left edge on otherwise-flush prose. `wrap-ansi`'s own
default (`trim: true`) doesn't have this problem; the patch just stops ink
from overriding it. Regression test: `apps/cli/src/view/MarkdownView.test.ts`.

The patch only reaches this monorepo's own `apps/cli/node_modules/ink` — it is
not part of `@agentionai/marshall-cli`'s published files, so it does not fix
the bug for someone who installs the CLI from npm rather than running it from
this checkout. Shipping the fix to published installs would need the patch
(or the fix) carried through the publish step; that hasn't been done.

The root `postinstall` `cd`s into `apps/cli` before invoking `patch-package`
because `ink` isn't hoisted to the repo root, and `patch-package` only looks
for `node_modules/<name>` under whatever directory it treats as the app root.

## Release process

Use Changesets for user-facing package changes. Add a changeset under `.changeset/`
with the real workspace package names, then apply it from the repository root:

```bash
npx @changesets/cli status
npx @changesets/cli version
npm install
npm test
```

Review the generated package versions, changelogs, and lockfile. Commit the
changeset output and implementation together, then publish from an authenticated
npm session after pushing the release commit:

```bash
npm whoami
npx @changesets/cli publish
git push --follow-tags origin main
```

Do not put npm tokens or other release credentials in the repository. If publish
is interrupted, inspect Changeset status and rerun the publish command rather
than creating another version commit.
