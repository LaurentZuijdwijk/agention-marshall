import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Properties of what we ship that a Linux dev box cannot notice.
 *
 * Every package publishes `dist` and nothing else, and neither has a `prepare`
 * script — so whatever tsc emitted is what a user installs, unexamined.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SOURCE_TREES = ['apps/cli/src', 'packages/engine/src', 'packages/tools/src'];

function filesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(path));
    else if (/\.tsx?$/.test(entry.name)) found.push(path);
  }
  return found;
}

describe('published filenames', () => {
  it('never differ from each other only by case', () => {
    // macOS and Windows resolve paths case-insensitively, so two modules whose
    // names differ only in case collide when npm unpacks the tarball: one
    // overwrites the other, and an import of the loser resolves to a module
    // without the export it asked for. The CLI shipped `view/Markdown.tsx`
    // (the component) beside `view/markdown.ts` (the parser it imports), which
    // crashed at startup for everyone not on a case-sensitive filesystem.
    //
    // Invisible from here — the failure is in the unpacking, not the build —
    // which is why it needs a test rather than a code review.
    const byLowercase = new Map<string, string[]>();
    for (const tree of SOURCE_TREES) {
      for (const file of filesUnder(join(repoRoot, tree))) {
        // Compared without the extension: `markdown.ts` and `Markdown.tsx`
        // become `markdown.js` and `Markdown.js` in dist, and collide there
        // even though the sources look distinct.
        const emitted = relative(repoRoot, file).replace(/\.tsx?$/, '.js');
        const key = emitted.toLowerCase();
        const clash = byLowercase.get(key);
        if (clash) clash.push(emitted);
        else byLowercase.set(key, [emitted]);
      }
    }

    const collisions = [...byLowercase.values()].filter(paths => paths.length > 1);
    assert.deepEqual(collisions, [],
      `these would overwrite each other on a case-insensitive filesystem:\n${
        collisions.map(paths => `  ${paths.join('  vs  ')}`).join('\n')}`);
  });
});
