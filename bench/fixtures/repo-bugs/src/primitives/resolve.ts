import { resolve, relative, isAbsolute } from 'node:path';
import { realpathSync, existsSync } from 'node:fs';

export class PathEscapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathEscapeError';
  }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  // relative() returns '' for root itself, or a path not starting with '..'
  // if the result is absolute or starts with '..', the target is outside
  return !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Resolve `inputPath` against `root`, rejecting any path that escapes the
 * workspace — including `..` traversal, absolute paths outside root, and
 * symlinks that point outside root.
 *
 * For paths that don't exist yet (e.g. a file about to be written), the
 * nearest existing ancestor is checked instead.
 */
export function resolveInWorkspace(root: string, inputPath: string): string {
  const realRoot = realpathSync(root);

  // resolve() with an absolute inputPath ignores the base — that's intentional:
  // an absolute path outside root will fail the isInside check below.
  const candidate = resolve(realRoot, inputPath);

  if (!isInside(realRoot, candidate)) {
    throw new PathEscapeError(`Path escapes workspace root: "${inputPath}"`);
  }

  if (existsSync(candidate)) {
    const real = realpathSync(candidate);
    if (!isInside(realRoot, real) && real !== realRoot) {
      throw new PathEscapeError(`Path escapes workspace via symlink: "${inputPath}"`);
    }
    return real;
  }

  // Path doesn't exist yet — walk up to the nearest existing ancestor and
  // symlink-check that instead.
  let check = resolve(candidate, '..');
  while (check !== realRoot && !existsSync(check)) {
    const parent = resolve(check, '..');
    if (parent === check) break;
    check = parent;
  }
  if (existsSync(check)) {
    const real = realpathSync(check);
    if (!isInside(realRoot, real) && real !== realRoot) {
      throw new PathEscapeError(`Path escapes workspace via symlink: "${inputPath}"`);
    }
  }

  return candidate;
}
