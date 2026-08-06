import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { version: currentVersion, name: packageName } = require('../package.json') as {
  version: string;
  name: string;
};

export { currentVersion, packageName };

/** A published release that is newer than the one running. */
export interface UpdateInfo {
  current: string;
  latest: string;
}

/**
 * Is `candidate` a later release than `current`?
 *
 * Field-by-field numeric compare rather than a string compare, which gets 0.10.0
 * vs 0.9.0 backwards. Any prerelease suffix is dropped first, so `1.2.0-beta.1`
 * does not read as newer than `1.2.0` — the suffix would otherwise split into a
 * fourth field and win on it.
 */
export function isNewer(candidate: string, current: string): boolean {
  const parts = (v: string) => v.split('-')[0].split('.').map(part => parseInt(part, 10) || 0);
  const [a, b] = [parts(candidate), parts(current)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

/**
 * The bare fact, with no opinion about what to do next.
 *
 * Callers disagree on that part — the startup row points at `/update`, while
 * `/update` itself is already installing — so baking an instruction in here
 * meant one of them always read wrong.
 */
export function describeUpdate(info: UpdateInfo): string {
  return `update available: ${info.current} → ${info.latest}`;
}

/** The command to run when we could not do it for them. */
export function manualInstallCommand(pkg = packageName): string {
  return `npm install -g ${pkg}@latest`;
}

/** Resolves to the newer release, or null if up-to-date or the check fails. */
export async function checkForUpdate(current = currentVersion): Promise<UpdateInfo | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${packageName}/latest`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const { version: latest } = await res.json() as { version: string };
    return isNewer(latest, current) ? { current, latest } : null;
  } catch {
    // network unavailable or timed out — silently skip
    return null;
  }
}
