# @agentionai/marshall-engine

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

- Model discovery moved into the engine and is now exported: `parseLlamaCppModels`,
  `applyLlamaCppProps`, `parseOllamaModels`, `parseOpenRouterModels`, the
  `formatContext` / `formatParams` / `formatBytes` helpers, and the `ModelInfo`
  type. These parse what llama.cpp, ollama and OpenRouter report about the models
  they serve, which is provider knowledge rather than presentation — any client
  with a model picker needs it.

## 0.3.0

### Minor Changes

- Rename from @marshall/_ to @agentionai/marshall-_

### Patch Changes

- Updated dependencies
  - @agentionai/marshall-tools@0.3.0

## 0.2.0

### Minor Changes

- Initial release

### Patch Changes

- Updated dependencies
  - @agentionai/marshall-tools@0.2.0
