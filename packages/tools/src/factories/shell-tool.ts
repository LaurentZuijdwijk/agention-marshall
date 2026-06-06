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
  } = config;

  const run_shell_spec: ToolSpec = {
    name: 'run_shell',
    description:
      'Run a shell command inside the workspace directory. ' +
      'The command runs with a scrubbed environment, a timeout, and ' +
      'capped output. Returns stdout, stderr, and exit code.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run (passed to sh -c)' },
      },
      required: ['command'],
    },
    execute: async ({ command }) => {
      if (signal?.aborted) return 'Task interrupted — command was not run.';
      const cmd = String(command);
      const verdict = checkPolicy(cmd, commandPolicy);

      if (verdict === 'deny') {
        return `Command blocked by policy: "${cmd}". This command matches a restricted pattern.`;
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
    ({ command }) => ({
      toolName: 'run_shell',
      description: `Run: ${command}`,
      detail: `$ ${command}`,
    }),
    signal,
  );
}
