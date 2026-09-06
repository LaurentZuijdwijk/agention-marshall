/**
 * The one and only place in the repo that knows a specific plugin package
 * exists. `packages/engine`'s `PluginRegistry` is fully generic — it
 * `import()`s whatever `PluginConfig.package` names and never depends on any
 * particular plugin — so this is CLI-only, and is also where "install"
 * folds into "add" for v1: `@agentionai/marshall-plugin-browser` already
 * ships as a real dependency of this package (see package.json), so there is
 * no separate install step to perform. `/plugins add <name>` looks a
 * not-yet-configured name up here to learn which package to spawn; once
 * enabled, the resulting `PluginConfig` (package, name, token) is persisted,
 * and this lookup is never consulted again for that plugin.
 *
 * A real `/plugins install <npm-package>` for arbitrary third-party plugins —
 * the whole reason the fuller design distributes plugins as private npm
 * packages — is future work once that hook system exists.
 */
export const KNOWN_PLUGINS: Record<string, string> = {
  browser: '@agentionai/marshall-plugin-browser/plugin',
};
