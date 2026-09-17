# @agentionai/marshall-plugin-browser

## 0.3.1

### Patch Changes

- a16b8a0: Link a local guided extension installation page when enabling the browser plugin, with a ZIP download button, Chrome/Edge instructions, pairing help, and a website download link. Build the public extension ZIP during website deployment.

  The CLI loads the plugin's setup instructions lazily and prints an upgrade notice instead of failing when the installed plugin predates the export; the CLI now pins `@agentionai/marshall-plugin-browser` to `^0.3.1` rather than `*`.

## 0.3.0

### Minor Changes

- e771ee1: Add `browser_press_key`, and make page reads markdown by default.

  `browser_press_key` presses a named key (Enter, Escape, Tab, arrows, Backspace, Delete, Home/End,
  Page Up/Down, or a single character) with optional Ctrl/Shift/Alt/Meta modifiers, against a
  selector or the currently focused element — covers form submission and dialog dismissal that
  `browser_type` alone can't reach.

  `browser_read_page` gains a `markdown` format alongside the existing `text`/`html`, and it is now
  the default. It keeps structure — headings, lists, bold/italic/code, and links with their `href`
  resolved to an absolute URL — at a fraction of `html`'s token cost, so the model can act on a link
  without a second `html` read just to find its destination.

## 0.2.0

### Minor Changes

- Add browser control and screenshots for the coding agent, via a new local MCP server (`@agentionai/marshall-plugin-browser`) backed by a companion Chrome extension (`packages/browser-extension`, unpublished). Screenshots reach the model as real vision input: MCP tool results can now carry image content that lands in front of the model on the next turn, via a new `ToolConfig.attachImages` — any MCP server returning image content benefits, not just this one. `browser_read_page` supports a token-cheap `text` mode (default) and a full `html` mode. The extension shows a small on-page indicator while Marshall is driving a tab, hidden automatically during a screenshot.

  Also adds a minimal, real slice of the plugin system: a `plugins` config array and a `/plugins add|disable|list` command that spawns a locally-managed plugin's server, health-checks it, and auto-registers it as an MCP server — no more hand-editing `mcpServers` or re-pasting a pairing token every session. `/plugins add browser` is the first consumer.
