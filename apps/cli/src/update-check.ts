import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { version: currentVersion, name: packageName } = require('../package.json') as {
  version: string;
  name: string;
};

export { currentVersion };

/** Resolves to an update notice string, or null if up-to-date or check fails. */
export async function checkForUpdate(): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${packageName}/latest`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const { version: latest } = await res.json() as { version: string };
    if (latest !== currentVersion) {
      return `update available: ${currentVersion} → ${latest}  (npm install -g ${packageName}@latest)`;
    }
  } catch {
    // network unavailable or timed out — silently skip
  }
  return null;
}
