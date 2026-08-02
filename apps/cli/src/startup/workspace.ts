// ── where we are, and what the environment says ───────────────────────────────

import { resolve, dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { config as loadDotenv } from 'dotenv';

export function findGitRoot(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Explicit path wins, then the enclosing repo, then wherever we were run.
 *
 * Relative paths resolve against `cwd` rather than `process.cwd()` — the two are
 * the same in production, but only the former makes the argument meaningful.
 */
export function resolveWorkspaceRoot(positional: string | undefined, cwd = process.cwd()): string {
  return resolve(cwd, positional ?? findGitRoot(cwd) ?? cwd);
}

/**
 * Load `.env` files: the workspace dir first, then walk up from cwd to the git
 * root, so monorepo setups work regardless of which directory npm runs from.
 *
 * `override: false` means shell env vars always win over `.env` values.
 */
export function loadEnvFiles(workspaceRoot: string, cwd = process.cwd()): void {
  const seen = new Set<string>();
  const load = (dir: string) => {
    const path = join(resolve(dir), '.env');
    if (seen.has(path)) return;
    seen.add(path);
    loadDotenv({ path, override: false });
  };

  load(workspaceRoot);

  let dir = cwd;
  while (true) {
    load(dir);
    if (existsSync(join(dir, '.git'))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}
