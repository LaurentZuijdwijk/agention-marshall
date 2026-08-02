import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { version: currentVersion, name: packageName } = require('../package.json') as {
  version: string;
  name: string;
};

export { currentVersion };

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

/** The notice for a version pair, or null when there is nothing to say. */
export function updateNotice(latest: string, current = currentVersion, pkg = packageName): string | null {
  return isNewer(latest, current)
    ? `update available: ${current} → ${latest}  (npm install -g ${pkg}@latest)`
    : null;
}

/** Resolves to an update notice string, or null if up-to-date or the check fails. */
export async function checkForUpdate(): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${packageName}/latest`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const { version: latest } = await res.json() as { version: string };
    return updateNotice(latest);
  } catch {
    // network unavailable or timed out — silently skip
    return null;
  }
}
