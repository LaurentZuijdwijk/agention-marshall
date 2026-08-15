// Raise V8's old-space heap cap so very long sessions don't run out of memory.
//
// A long-running session - an hour of agent generation leaves a large reasoning
// trace in memory - can exceed Node's default old-space limit and die with
// "JavaScript heap out of memory". The cap can only be changed by a *startup*
// flag (`v8.setFlagsFromString` is a no-op for it once V8 is up), so when no
// such flag is already in effect we re-exec ourselves with
// `--max-old-space-size` and hand the terminal to the child.
//
// Override the size with MARSHALL_MAX_OLD_SPACE (MB). The wrapper never
// respawns when the flag is already present, so `NODE_OPTIONS` users and the
// one-time reload marker both short-circuit cleanly.

import { spawn } from 'node:child_process';

const RELOAD_MARKER = 'MARSHALL_OLD_SPACE_RELOADED';
const DEFAULT_OLD_SPACE_MB = 8192;

function heapAlreadyRaised(): boolean {
  if (process.env[RELOAD_MARKER] === '1') return true;
  const re = /^--max-old-space-size/;
  if (process.execArgv.some(a => re.test(a))) return true;
  return re.test(process.env.NODE_OPTIONS ?? '');
}

/**
 * Returns a detached child process owning the rest of the boot when an old-space
 * cap had to be injected, or `undefined` when the current process is fine to
 * continue (the cap was already set, or the reload marker is present).
 */
export function maybeRespawnForHeap(): ReturnType<typeof spawn> | undefined {
  if (heapAlreadyRaised()) return undefined;

  const mb = Number(process.env.MARSHALL_MAX_OLD_SPACE ?? DEFAULT_OLD_SPACE_MB);
  const size = Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_OLD_SPACE_MB;

  // Re-run ourselves, carrying Node's exec flags (e.g. tsx's --import loader
  // in a checkout) and the user's arguments. The marker stops the child from
  // respawning again, whether or not the heap flag survives into execArgv.
  // `process.argv[1]` is the entry script actually being run (`src/index.tsx` in
  // a checkout, `dist/index.js` published); `import.meta.url` here is this file's
  // own path, which is why it must not be used as the thing to re-run.
  const child = spawn(process.execPath,
    [
      ...process.execArgv,
      `--max-old-space-size=${size}`,
      process.argv[1],
      ...process.argv.slice(2),
    ],
    { stdio: 'inherit', env: { ...process.env, [RELOAD_MARKER]: '1' } });
  return child;
}