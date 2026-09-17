---
"@agentionai/marshall-plugin-browser": patch
"@agentionai/marshall-cli": patch
---

Link a local guided extension installation page when enabling the browser plugin, with a ZIP download button, Chrome/Edge instructions, pairing help, and a website download link. Build the public extension ZIP during website deployment.

The CLI loads the plugin's setup instructions lazily and prints an upgrade notice instead of failing when the installed plugin predates the export; the CLI now pins `@agentionai/marshall-plugin-browser` to `^0.3.1` rather than `*`.
