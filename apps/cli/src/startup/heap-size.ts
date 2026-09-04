// Raise V8's old-space heap cap so very long sessions don't run out of memory,
// and make sure the process that actually renders is running with
// NODE_ENV=production — both need a re-exec, so one respawn does both.
//
// A long-running session - an hour of agent generation leaves a large reasoning
// trace in memory - can exceed Node's default old-space limit and die with
// "JavaScript heap out of memory". The cap can only be changed by a *startup*
// flag (`v8.setFlagsFromString` is a no-op for it once V8 is up), so when no
// such flag is already in effect we re-exec ourselves with
// `--max-old-space-size` and hand the terminal to the child.
//
// The same re-exec is what fixes an unrelated but equally real problem: with
// NODE_ENV unset (the default for every plain `marshall` invocation), Ink's
// react-reconciler loads its development build, which marks/measures every
// single render via `perf_hooks` and never clears the buffer. A session that
// streams heavily for an hour comfortably crosses Node's 1,000,000-entry
// warning threshold — confirmed live: a 1h41m tetris-generation session hit
// `MaxPerformanceEntryBufferExceededWarning` at exactly 1,000,001 entries.
// Setting NODE_ENV can't be done in index.tsx itself: it's an ES module, and
// ESM import declarations always evaluate before any other top-level code in
// that file, so an assignment placed above `import { render } from 'ink'`
// would still run after Ink (and react-reconciler's dev/prod check) has
// already loaded. A fresh child process's env, by contrast, is fixed before
// Node even starts parsing its entry file, so it isn't racing anything.
//
// Piggybacking costs nothing extra: this respawn already happens on
// essentially every normal launch (nothing sets the heap flag or the reload
// marker on a first run), and the parent never renders — it only imports Ink,
// waits for the child, and exits — so its own dev-build import never commits
// a render and never marks anything. Only the child, which owns the session
// for as long as it runs, needs the production build, and now gets it.
//
// Override the heap size with MARSHALL_MAX_OLD_SPACE (MB). The wrapper skips
// the respawn only when both the heap flag and NODE_ENV are already in
// effect, so `NODE_OPTIONS`/`NODE_ENV` users and the one-time reload marker
// all short-circuit cleanly.

import { spawn } from 'node:child_process';

const RELOAD_MARKER = 'MARSHALL_OLD_SPACE_RELOADED';
/**
 * Set alongside NODE_ENV when *we* chose the value, never when the user did.
 *
 * Read by `scrubbedEnv` in @agentionai/marshall-tools, which drops NODE_ENV
 * from sandboxed commands when it sees this. Exported so the two ends of that
 * contract are one string rather than two spellings that can drift apart.
 */
export const INJECTED_MARKER = 'MARSHALL_INJECTED_NODE_ENV';
const DEFAULT_OLD_SPACE_MB = 8192;

function heapAlreadyRaised(env: NodeJS.ProcessEnv, execArgv: readonly string[]): boolean {
  if (env[RELOAD_MARKER] === '1') return true;
  const re = /^--max-old-space-size/;
  if (execArgv.some(a => re.test(a))) return true;
  return re.test(env.NODE_OPTIONS ?? '');
}

export interface RespawnPlan {
  /** `false` means: continue in this process, nothing to do. */
  needed: boolean;
  /** Extra V8 flag to inject, when the heap cap wasn't already raised. */
  heapFlag?: string;
  /** The full env the child should get, heap marker and NODE_ENV included. */
  env: NodeJS.ProcessEnv;
}

/**
 * Pure decision logic, kept separate from `spawn()` itself so the interesting
 * part — whether to respawn, and with what — is testable without actually
 * launching a process.
 */
export function planRespawn(env: NodeJS.ProcessEnv, execArgv: readonly string[]): RespawnPlan {
  const needsHeap = !heapAlreadyRaised(env, execArgv);
  // Only fills a gap, never overrides: a marshall developer who has
  // deliberately set NODE_ENV=development to get react-reconciler's dev
  // warnings while working on the TUI keeps that choice.
  const needsProdEnv = env.NODE_ENV === undefined;

  if (!needsHeap && !needsProdEnv) return { needed: false, env };

  const mb = Number(env.MARSHALL_MAX_OLD_SPACE ?? DEFAULT_OLD_SPACE_MB);
  const size = Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_OLD_SPACE_MB;

  return {
    needed: true,
    heapFlag: needsHeap ? `--max-old-space-size=${size}` : undefined,
    env: {
      ...env,
      [RELOAD_MARKER]: '1',
      NODE_ENV: env.NODE_ENV ?? 'production',
      // Records that the value above is ours rather than the user's, so the
      // tool sandbox can decline to forward it into the commands the agent
      // runs. It must not: this NODE_ENV exists to pick a React build for our
      // own renderer, and `npm install` under NODE_ENV=production omits
      // devDependencies — the agent would install a workspace with no test
      // runner and no compiler, and be told nothing. See `scrubbedEnv` in
      // @agentionai/marshall-tools. Only set when we filled the gap; a
      // deliberate NODE_ENV from the user carries no marker and is forwarded
      // as it always was.
      ...(needsProdEnv ? { [INJECTED_MARKER]: '1' } : {}),
    },
  };
}

/**
 * Returns a detached child process owning the rest of the boot when a re-exec
 * was needed (old-space cap, NODE_ENV, or both), or `undefined` when the
 * current process is fine to continue as-is.
 */
export function maybeRespawnForHeap(): ReturnType<typeof spawn> | undefined {
  const plan = planRespawn(process.env, process.execArgv);
  if (!plan.needed) return undefined;

  // Re-run ourselves, carrying Node's exec flags (e.g. tsx's --import loader
  // in a checkout) and the user's arguments. The marker stops the child from
  // respawning again, whether or not the heap flag survives into execArgv.
  // `process.argv[1]` is the entry script actually being run (`src/index.tsx` in
  // a checkout, `dist/index.js` published); `import.meta.url` here is this file's
  // own path, which is why it must not be used as the thing to re-run.
  return spawn(process.execPath,
    [
      ...process.execArgv,
      ...(plan.heapFlag ? [plan.heapFlag] : []),
      process.argv[1],
      ...process.argv.slice(2),
    ],
    { stdio: 'inherit', env: plan.env });
}
