---
"@agentionai/marshall-cli": minor
---

Centralize config reads and writes in one `ConfigService`, fixing a removed provider or MCP
server reappearing after a restart.

Five independent read-modify-write functions (`saveConfig`, `saveMcpServers`,
`saveProjectMcpSelection`, `removeSavedProvider`, `saveSettings`) each did their own
read-parse-write cycle and could race each other, and the App kept its own copies of the same
data in props — so a write that landed on disk could leave the screen showing the old value,
and a removed provider or MCP server could come back on the next launch. `ConfigService` is now
the one owner of both config files: a single queued write path, disk as the source of truth, and
the UI re-renders straight off a file change instead of a stale prop.

The `/setup` settings menu moves onto the same service, replacing the previous ad-hoc
provider/runtime/safety flows with one place to add, remove and switch providers, and to change
runtime mode or the safety level.
