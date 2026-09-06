# @agentionai/marshall-plugin-browser

## 0.2.0

### Minor Changes

- Add browser control and screenshots for the coding agent, via a new local MCP server (`@agentionai/marshall-plugin-browser`) backed by a companion Chrome extension (`packages/browser-extension`, unpublished). Screenshots reach the model as real vision input: MCP tool results can now carry image content that lands in front of the model on the next turn, via a new `ToolConfig.attachImages` — any MCP server returning image content benefits, not just this one. `browser_read_page` supports a token-cheap `text` mode (default) and a full `html` mode. The extension shows a small on-page indicator while Marshall is driving a tab, hidden automatically during a screenshot.

  Also adds a minimal, real slice of the plugin system: a `plugins` config array and a `/plugins add|disable|list` command that spawns a locally-managed plugin's server, health-checks it, and auto-registers it as an MCP server — no more hand-editing `mcpServers` or re-pasting a pairing token every session. `/plugins add browser` is the first consumer.
