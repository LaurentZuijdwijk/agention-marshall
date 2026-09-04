// ── running pi / opencode through the same tasks ────────────────────────────
//
// `runOne` in run.ts drives marshall's own `Session` in-process. These two
// shell out to the real CLIs instead — the same tasks, the same fixtures, the
// same `check()` verifiers, so a result here is directly comparable to a
// marshall row in the same results table. Nothing about the task definitions
// changes: `BenchTask.check` never knows or cares which harness produced the
// response it's given.

import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { promisify } from 'node:util';
import type { BenchTask } from './tasks.js';

const execFileAsync = promisify(execFile);

/** POSIX single-quote escaping: end the quote, emit an escaped quote, reopen it. */
function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Runs a command as if from an interactive terminal.
 *
 * Both `pi` and `opencode` hang indefinitely — no output, no error, no
 * timeout of their own — when their stdout isn't a TTY, which is exactly
 * what `child_process.execFile`/`spawn` gives a child by default. Confirmed
 * by direct comparison: the identical command completes in seconds run
 * through a pty (`script -qec ...`) and never returns at all piped normally.
 * Neither CLI documents this, so wrapping every external-harness call in a
 * pty (`script`, from util-linux — Linux only; BSD/macOS `script` takes
 * different flags, see bench/README.md) is the fix, not a workaround for
 * something on our side.
 */
async function execViaPty(command: string[], options: { cwd: string; timeout: number; env?: NodeJS.ProcessEnv }): Promise<{ stdout: string }> {
  const commandLine = command.map(shellQuote).join(' ');
  return execFileAsync('script', ['-qec', commandLine, '/dev/null'], {
    cwd: options.cwd,
    timeout: options.timeout,
    maxBuffer: 64 * 1024 * 1024,
    env: options.env ? { ...process.env, ...options.env } : process.env,
  });
}

/**
 * The same pty wrapper, but streaming a line at a time.
 *
 * `execFile` buffers the child's entire output before returning, under a fixed
 * `maxBuffer`. That is fine for a six-tool-call task and untenable for a long
 * one: `pi --mode json` re-emits the *whole* assistant message on every token
 * delta, so a run that generates ten thousand tokens produces hundreds of
 * megabytes of stdout and trips the cap partway through — losing the run, and
 * losing it in a way that looks like the harness crashed rather than like a
 * buffer filling up. Consuming line by line keeps memory flat regardless of run
 * length, since the caller extracts what it needs and drops the rest.
 */
function execViaPtyStreaming(
  command: string[],
  options: { cwd: string; timeout: number; env?: NodeJS.ProcessEnv },
  onLine: (line: string) => void,
): Promise<{ timedOut: boolean; code: number | null }> {
  const commandLine = command.map(shellQuote).join(' ');
  return new Promise((resolve, reject) => {
    const child = spawn('script', ['-qec', commandLine, '/dev/null'], {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeout);

    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    });
    // stderr is drained but discarded: pi writes progress chrome there, and
    // leaving it unread would eventually block the child on a full pipe.
    child.stderr.resume();

    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => {
      clearTimeout(timer);
      if (buffer) onLine(buffer);
      resolve({ timedOut, code });
    });
  });
}

export interface ExternalHarnessConfig {
  name: string;
  harness: 'pi' | 'opencode';
  /** `provider/model`, exactly as each CLI's `--model` flag expects it. */
  model: string;
  /**
   * The CLI's own provider name. `openrouter` bills a real API; `llama-cpp`
   * points at the same local router the marshall configs use, which is what
   * makes a `pi` row and a marshall row comparable rather than merely adjacent.
   */
  provider?: 'openrouter' | 'llama-cpp';
  /**
   * `PI_CODING_AGENT_DIR` for this row — a bench-owned config directory, so the
   * run neither depends on nor modifies the machine's own `~/.pi`. Required for
   * `llama-cpp`, since `pi` does not enumerate the router and the model has to
   * be pinned in that directory's `models.json`.
   */
  configDir?: string;
}

export interface ExternalRunOptions {
  /** File to tee the CLI's raw event stream into, for after-the-fact auditing. */
  transcriptPath?: string;
}

export interface ExternalRunOutcome {
  response: string;
  toolCalls: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  /** Set when the harness itself errored (crashed, rate-limited, timed out) —
   *  distinct from the task's `check()` failing on a well-formed answer. */
  error?: string;
}

/**
 * `pi --mode json` streams one JSON object per line — message deltas, tool-call
 * events, and a `turn_end` per provider request carrying that request's answer
 * and a structured `usage` block (`input`/`output`/`cacheRead`/`cacheWrite`).
 *
 * Summing `input + cacheRead + cacheWrite` is deliberate: cache hits still cost
 * real (if cheaper) tokens, and reporting only `input` understates a warm-cache
 * turn by an order of magnitude — see docs/competitive-findings.md for how that
 * skewed an earlier, less careful comparison. Against a local router there is
 * no billing at all, so `costUsd` is left undefined rather than reported as a
 * misleading $0.00.
 *
 * Parsed as it arrives rather than from a buffered dump — see
 * `execViaPtyStreaming` for why that matters on a long run.
 */
async function runPi(config: ExternalHarnessConfig, task: BenchTask, workspaceDir: string, apiKey: string, timeoutMs: number, options: ExternalRunOptions = {}): Promise<ExternalRunOutcome> {
  const local = config.provider === 'llama-cpp';
  const command = [
    'pi',
    '--provider', config.provider ?? 'openrouter',
    '--model', config.model,
    '--no-session', '--mode', 'json',
    '-p', task.prompt,
  ];
  // The key goes in the environment, never in argv. This whole command is
  // joined into one string for `script -qec`, so `--api-key sk-or-…` would sit
  // in /proc and be readable by every user on the host for the length of the
  // run. pi resolves `OPENROUTER_API_KEY` itself (pi-ai's env map:
  // openrouter -> OPENROUTER_API_KEY), so there is nothing to pass explicitly.
  // A local router authenticates nothing and gets no key at all.
  const env: NodeJS.ProcessEnv = {
    ...(config.configDir ? { PI_CODING_AGENT_DIR: config.configDir } : {}),
    ...(local ? {} : { OPENROUTER_API_KEY: apiKey }),
  };

  let response = '';
  let toolCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;

  // Written as it streams rather than buffered: the point of the streaming
  // parse is that a long run's transcript never has to fit in memory at once.
  const transcript = options.transcriptPath ? createWriteStream(options.transcriptPath) : undefined;

  const onLine = (line: string) => {
    if (!line.trim()) return;
    transcript?.write(line + '\n');
    let event: Record<string, unknown>;
    try { event = JSON.parse(line); } catch { return; }

    const assistantEvent = event.assistantMessageEvent as Record<string, unknown> | undefined;
    if (assistantEvent?.type === 'toolcall_end') toolCalls++;

    if (event.type !== 'turn_end') return;
    // One `turn_end` per provider request, not per user prompt: pi's turn loop
    // repeats for as long as the model keeps calling tools, so these accumulate
    // across the whole run rather than describing it once.
    const message = event.message as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
    } | undefined;
    const textBlock = message?.content?.find(c => c.type === 'text');
    if (textBlock?.text) response = textBlock.text;
    const usage = message?.usage;
    if (usage) {
      inputTokens += (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
      outputTokens += usage.output ?? 0;
      costUsd += usage.cost?.total ?? 0;
    }
  };

  try {
    const { timedOut } = await execViaPtyStreaming(command, { cwd: workspaceDir, timeout: timeoutMs, env }, onLine);
    if (timedOut) return { response, toolCalls, inputTokens, outputTokens, costUsd, error: 'timeout' };
  } catch (err) {
    return { response: '', toolCalls: 0, error: (err as Error).message.slice(0, 300) };
  } finally {
    transcript?.end();
  }

  return { response, toolCalls, inputTokens, outputTokens, costUsd: local ? undefined : costUsd };
}

/**
 * `opencode run` has no working structured-output mode we found (`--format
 * json` produced no stdout at all in testing — see docs/competitive-findings.md)
 * so this parses the human-readable terminal transcript instead: tool
 * invocations are lines starting with `$ ` (bash) or the `✱`/`✗` glyphs
 * (its built-in tools), and the response is whatever text follows the last
 * one. That makes `toolCalls` here an approximation and token counts
 * unavailable — both are documented limitations, not silent gaps; see
 * bench/README.md.
 */
async function runOpencode(config: ExternalHarnessConfig, task: BenchTask, workspaceDir: string, timeoutMs: number): Promise<ExternalRunOutcome> {
  let stdout: string;
  try {
    const result = await execViaPty(
      ['opencode', 'run', '--model', `openrouter/${config.model}`, task.prompt],
      { cwd: workspaceDir, timeout: timeoutMs },
    );
    stdout = result.stdout;
  } catch (err) {
    const stdout2 = (err as { stdout?: string }).stdout ?? '';
    return { response: '', toolCalls: 0, error: (err as Error).message.slice(0, 300) || stdout2.slice(0, 300) };
  }

  // Strip ANSI escapes so the line-prefix checks below see plain text.
  // eslint-disable-next-line no-control-regex
  const clean = stdout.replace(/\x1b\[[0-9;]*m/g, '');
  const lines = clean.split('\n');

  const toolCalls = lines.filter(l => /^\$ /.test(l.trim()) || /^[✱✗] /.test(l.trim())).length;

  // The response is the run of non-tool, non-empty lines at the end of the
  // transcript — opencode prints its final answer last, with no marker of
  // its own to anchor on.
  let end = lines.length;
  while (end > 0 && !lines[end - 1].trim()) end--;
  let start = end;
  while (start > 0 && lines[start - 1].trim() && !/^\$ /.test(lines[start - 1].trim()) && !/^[✱✗] /.test(lines[start - 1].trim())) {
    start--;
  }
  const response = lines.slice(start, end).join('\n').trim();

  return { response, toolCalls };
}

export async function runExternal(
  config: ExternalHarnessConfig,
  task: BenchTask,
  workspaceDir: string,
  apiKey: string,
  /** Match this to marshall's own TASK_TIMEOUT_MS — a shorter budget here
   *  would report a genuinely complex task as a timeout for pi/opencode in
   *  a case where marshall was simply given more time to finish it. */
  timeoutMs: number,
  options: ExternalRunOptions = {},
): Promise<ExternalRunOutcome> {
  return config.harness === 'pi'
    ? runPi(config, task, workspaceDir, apiKey, timeoutMs, options)
    : runOpencode(config, task, workspaceDir, timeoutMs);
}
