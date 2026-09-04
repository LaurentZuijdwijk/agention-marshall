import { spawn } from 'node:child_process';

export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024; // 64 KiB per stream

const ALLOWED_ENV_KEYS: ReadonlySet<string> = new Set([
  'HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM',
  'NODE_ENV', 'npm_config_prefix',
  // git / gh
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
  'GITHUB_TOKEN', 'GH_TOKEN',
  'GH_HOST', 'GH_REPO',
  'SSH_AUTH_SOCK', 'SSH_AGENT_PID',
]);

/**
 * Set by the CLI when it picked `NODE_ENV` itself rather than inheriting one.
 *
 * The CLI re-execs with `NODE_ENV=production` so Ink loads React's production
 * reconciler — a decision about our own renderer that has no business reaching
 * the user's project. `npm install` under `NODE_ENV=production` sets
 * `omit=dev`, so a workspace would be installed without its test runner,
 * compiler or linter, and the agent would be told nothing about it. Anything
 * else branching on NODE_ENV (jest configs, build tooling, project scripts)
 * would shift under it just as silently.
 *
 * Kept as a marker rather than dropping NODE_ENV outright, because a NODE_ENV
 * the *user* exported is a real instruction about their project and is still
 * forwarded.
 */
const INJECTED_NODE_ENV_MARKER = 'MARSHALL_INJECTED_NODE_ENV';

/**
 * The environment a sandboxed child gets: the allowlist above, nothing else.
 *
 * Shared with the background-job runner so both spawn paths scrub identically —
 * an env var that leaks into one but not the other would make "it works in the
 * foreground" a real and very confusing bug report.
 */
export function scrubbedEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ALLOWED_ENV_KEYS) {
    if (key === 'NODE_ENV' && process.env[INJECTED_NODE_ENV_MARKER] === '1') continue;
    const val = process.env[key];
    if (val !== undefined) env[key] = val;
  }
  return Object.assign(env, extra);
}

export interface SpawnSandboxedOptions {
  cwd: string;
  timeout?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  /** Extra env vars merged in after the scrubbed env */
  extraEnv?: Record<string, string>;
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
}

const OUTPUT_TRUNCATION_MARKER = '\n[...output truncated — size limit reached...]';

/**
 * Spawn `command` with `args` in a sandboxed environment:
 *   - cwd locked to the provided workspace directory
 *   - env scrubbed to an allowlist
 *   - killed (process group) on timeout or AbortSignal
 *   - stdout/stderr capped to maxOutputBytes each
 *
 * Never throws — errors are returned in the result.
 */
export async function spawnSandboxed(
  command: string,
  args: string[],
  options: SpawnSandboxedOptions,
): Promise<SpawnResult> {
  const {
    cwd,
    timeout = DEFAULT_TIMEOUT_MS,
    signal,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    extraEnv = {},
  } = options;

  const safeEnv = scrubbedEnv(extraEnv);

  return new Promise((resolve) => {
    let timedOut = false;
    let aborted = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const child = spawn(command, args, {
      cwd,
      env: safeEnv,
      detached: true, // creates a new process group so we can kill the whole tree
      stdio: 'pipe',
    });

    const killGroup = () => {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch {}
    };

    const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeout);

    const onAbort = () => { aborted = true; killGroup(); };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutBytes < maxOutputBytes) {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes < maxOutputBytes) {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      }
    });

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);

      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');

      resolve({
        stdout: stdoutBytes >= maxOutputBytes ? stdout + OUTPUT_TRUNCATION_MARKER : stdout,
        stderr: stderrBytes >= maxOutputBytes ? stderr + OUTPUT_TRUNCATION_MARKER : stderr,
        exitCode,
        timedOut,
        aborted,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ stdout: '', stderr: err.message, exitCode: null, timedOut: false, aborted: false });
    });
  });
}
