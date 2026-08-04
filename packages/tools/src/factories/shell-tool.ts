import type { ToolConfig, CommandPolicy, ToolSpec } from '../types.js';
import { spawnSandboxed } from '../primitives/spawn.js';
import { withApproval } from './approval.js';

export const DEFAULT_COMMAND_POLICY: CommandPolicy = {
  mode: 'denylist',
  patterns: [
    /rm\s+-rf\s+\//,           // rm -rf /
    /curl[^|]*\|\s*(ba)?sh/,   // curl | sh
    /wget[^|]*\|\s*(ba)?sh/,   // wget | sh
    /npm\s+publish/,           // npm publish
    /git\s+push.*--force/,     // git push --force
    /\bdd\s+if=/,              // dd (disk operations)
    /\bmkfs\b/,                // format filesystem
    /\b(shutdown|reboot|halt|poweroff)\b/, // system commands
  ],
};

type PolicyVerdict = 'allow' | 'deny';

function checkPolicy(command: string, policy: CommandPolicy): PolicyVerdict {
  if (policy.mode === 'none') return 'allow';

  if (policy.mode === 'denylist') {
    return policy.patterns.some(p => p.test(command)) ? 'deny' : 'allow';
  }

  // allowlist: must match at least one pattern
  return policy.patterns.some(p => p.test(command)) ? 'allow' : 'deny';
}

export function createShellTool(config: ToolConfig) {
  const {
    workspaceRoot,
    approval,
    signal,
    commandPolicy = DEFAULT_COMMAND_POLICY,
    limits = {},
    jobs,
  } = config;

  const backgroundDescription = jobs
    ? ' Set `background: true` for a command that should keep running past this ' +
      'step — a dev server, a watcher, or a suite too slow to block on. It returns ' +
      'a job id immediately; read new output with shell_output, and you will be ' +
      'told automatically when it finishes. Do not background a command whose ' +
      'result you need in order to decide what to do next in this same step.'
    : '';

  const run_shell_spec: ToolSpec = {
    name: 'run_shell',
    description:
      'Run a shell command inside the workspace directory. ' +
      'The command runs with a scrubbed environment, a 120 s timeout, and ' +
      'capped output. Returns stdout, stderr, and exit code. Long suites ' +
      '(full test runs, builds) should be scoped down or paged to fit.' +
      backgroundDescription,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run (passed to sh -c)' },
        ...(jobs
          ? {
              background: {
                type: 'boolean',
                description:
                  'Run detached and return a job id immediately instead of waiting for the command to finish.',
              },
            }
          : {}),
      },
      required: ['command'],
    },
    execute: async ({ command, background }) => {
      if (signal?.aborted) return 'Task interrupted — command was not run.';
      const cmd = String(command);
      const verdict = checkPolicy(cmd, commandPolicy);

      if (verdict === 'deny') {
        return `Command blocked by policy: "${cmd}". This command matches a restricted pattern.`;
      }

      if (jobs && background === true) {
        // Deliberately not given `signal`: the whole point is to outlive the turn.
        // The session's registry owns its lifetime and kills it on teardown.
        const job = jobs.start({
          command: cmd,
          cwd: workspaceRoot,
          timeoutMs: limits.backgroundTimeoutMs,
          maxOutputBytes: limits.maxOutputBytes,
        });
        return (
          `Started background job "${job.id}": ${cmd}\n` +
          `It runs independently of this step. Read new output with shell_output("${job.id}"), ` +
          `stop it with shell_kill("${job.id}"). You will be told when it finishes — ` +
          `do not poll it in a loop waiting for that.`
        );
      }

      const result = await spawnSandboxed('sh', ['-c', cmd], {
        cwd: workspaceRoot,
        signal,
        timeout: limits.timeoutMs,
        maxOutputBytes: limits.maxOutputBytes,
      });

      const parts: string[] = [];
      if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
      if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
      if (result.timedOut) parts.push('(command timed out and was killed)');
      if (result.aborted) parts.push('(command was aborted)');
      parts.push(`exit code: ${result.exitCode ?? 'null'}`);

      return parts.join('\n\n');
    },
  };

  return withApproval(
    run_shell_spec,
    approval,
    ({ command, background }) => ({
      toolName: 'run_shell',
      description: background === true ? `Run in background: ${command}` : `Run: ${command}`,
      // The prompt has to say it will outlive the turn — approving a command
      // that keeps running after the task ends is a different decision.
      detail: background === true ? `$ ${command}   (background)` : `$ ${command}`,
    }),
    signal,
    config.caller,
  );
}
