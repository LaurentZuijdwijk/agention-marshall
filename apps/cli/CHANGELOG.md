# @agentionai/marshall-cli

## 0.6.1

### Patch Changes

- Add a package README (installation, providers, commands, keybindings, and global/project config) so it renders on the npm package page.

## 0.6.0

### Minor Changes

- Move credentials and provider/model settings to a global user config at `~/.config/marshall/config.json` (or `$XDG_CONFIG_HOME/marshall/config.json`), created on first run. An optional project-local `.marshall/config.json` is deep-merged on top so a repo can pin its own model/provider without touching global credentials — session logs and task notes stay project-local as before.

## 0.5.0

### Minor Changes

- feat: add @path file completion and inline expansion, formatToolName for readable tool labels, open weights site rebrand

## 0.4.0

### Minor Changes

- Attach images to a task with ctrl-V.

  `Session.run()` takes an optional list of image attachments and sends them as
  content blocks alongside the task text. Ctrl-V reads the image off the system
  clipboard — terminal paste cannot carry one, since bracketed paste is a text
  protocol — using wl-paste or xclip on Linux, pngpaste on macOS, and PowerShell
  on Windows, and names what to install when none is present.

  Providers that cannot carry an image are refused before the request is spent
  rather than after: ollama drops image blocks silently, so the model would
  otherwise answer confidently about something it never received, and mistral
  accepts images only by URL. Images are capped at 5MB.

### Patch Changes

- Ctrl- and alt- chords no longer type themselves into the prompt. Only ctrl-C was
  excluded before, so every other chord also inserted its letter — ctrl-R had been
  quietly appending an "r" each time it toggled reasoning.

  The startup output-token default no longer flattens the tiers. It was resolved
  once from the deep provider and applied to the whole session, so a local deep
  tier handed its 32768 to a hosted fast tier; the engine now resolves the cap per
  profile, as it was written to. Pass `--max-tokens` to set one deliberately.

  The setup wizard offers openrouter, llamacpp and ollama first — the providers
  whose model list it actually fetches from the server.

- Updated dependencies
- Updated dependencies
  - @agentionai/marshall-engine@0.4.0

## 0.3.0

### Minor Changes

- Rename from @marshall/_ to @agentionai/marshall-_

### Patch Changes

- Updated dependencies
  - @agentionai/marshall-engine@0.3.0
  - @agentionai/marshall-tools@0.3.0

## 0.2.0

### Minor Changes

- Initial release

### Patch Changes

- Updated dependencies
  - @agentionai/marshall-engine@0.2.0
  - @agentionai/marshall-tools@0.2.0
