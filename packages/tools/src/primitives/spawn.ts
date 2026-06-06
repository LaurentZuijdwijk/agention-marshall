import { spawn } from 'node:child_process';

export const DEFAULT_TIMEOUT_MS = 30_000;
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

  const safeEnv: Record<string, string> = {};
  for (const key of ALLOWED_ENV_KEYS) {
    const val = process.env[key];
    if (val !== undefined) safeEnv[key] = val;
  }
  Object.assign(safeEnv, extraEnv);

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
