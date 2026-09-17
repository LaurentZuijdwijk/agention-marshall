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
import { manualInstallCommand } from '../update-check.js';

export const KNOWN_PLUGINS: Record<string, string> = {
  browser: '@agentionai/marshall-plugin-browser/plugin',
};

/**
 * The one function the CLI needs from the plugin: the guided-setup text shown
 * after `/plugins add browser`. Mirrored structurally rather than imported
 * statically (same pattern as the engine's `PluginRegistry`) so an installed
 * copy that predates the export is a value problem `loadExtensionSetupInstructions`
 * can report, not a startup crash of the whole CLI.
 */
export interface ExtensionSetupInstructions {
  (opts?: { paired?: boolean; port?: number }): string;
}

/**
 * Load the plugin's guided-setup export lazily, at the moment `/plugins add`
 * needs it. Returns null when the package is missing *or* predates the export —
 * the caller decides what to show (see `extensionSetupNotice`). Never throws:
 * a bad installed copy must not take the command, let alone the CLI, down.
 */
export async function loadExtensionSetupInstructions(
  load: () => Promise<unknown> = () => import(KNOWN_PLUGINS.browser),
): Promise<ExtensionSetupInstructions | null> {
  try {
    const mod = await load();
    const fn = (mod as { extensionSetupInstructions?: unknown }).extensionSetupInstructions;
    return typeof fn === 'function' ? (fn as ExtensionSetupInstructions) : null;
  } catch {
    return null;
  }
}

/** Probe the running server, not just the installed module: an older process
 * may have been reused by the plugin registry. Never follow a local redirect
 * or let optional setup help delay a command indefinitely. */
export async function browserSetupAvailable(port = 8712, request: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await request(`http://127.0.0.1:${port}/setup`, {
      method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(1500),
    });
    return response.ok && (response.headers.get('content-type') ?? '').includes('text/html');
  } catch {
    return false;
  }
}

/**
 * The text to print after enabling the browser plugin. Delegates to the
 * plugin when it can answer; otherwise says so and names the way out —
 * upgrading the CLI (which carries a pinned, newer plugin) and re-adding the
 * plugin in a fresh process, since the running one keeps its old copy.
 */
export function extensionSetupNotice(instructions: ExtensionSetupInstructions | null, opts: { paired: boolean; port?: number; setupAvailable?: boolean }): string {
  if (opts.setupAvailable === false) {
    return [
      'Browser plugin is running, but its server does not provide a reachable setup page.',
      `Marshall may have reused an older server already listening on port ${opts.port ?? 8712}. Updating files does not restart that process.`,
      'In the Marshall session that started it, run /plugins disable browser; for a standalone server, stop it in its original terminal.',
      'Then restart your updated Marshall and run /plugins add browser. Disabling from another session will not stop a server it does not own.',
      'Existing browser connections can continue working without the setup page.',
      'Manual setup and extension download: https://marshall.agention.ai/docs.html#browser-extension',
    ].join('\n');
  }
  try {
    const text = instructions?.({ paired: opts.paired, port: opts.port });
    if (typeof text === 'string' && text.trim()) return text;
  } catch {
    // Help text must not hide the running status or a newly generated token.
  }
  return [
    'Browser plugin is running, but guided setup help is unavailable in this installed copy.',
    'Existing browser connections can continue working; upgrading enables the latest setup help.',
    `Upgrade: ${manualInstallCommand()}`,
    'For a global npm installation, run the upgrade command in your shell. For a source checkout, pull the release, run npm install, then npm run build:all.',
    'Restart marshall, then run /plugins add browser.',
    'Manual setup steps: https://marshall.agention.ai/docs.html#browser-extension',
  ].join('\n');
}
