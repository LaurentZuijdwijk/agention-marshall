import { Tool } from '@agentionai/agents/core';
import type { ToolInputSchema } from '@agentionai/agents/core';
import { spawnSandboxed } from '../primitives/spawn.js';
import { withApproval } from './approval.js';
import type { ToolConfig, ToolSpec } from '../types.js';

function safe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function gh(
  args: string[],
  config: ToolConfig,
): Promise<string> {
  if (config.signal?.aborted) return 'Task interrupted.';
  const result = await spawnSandboxed('gh', args, {
    cwd: config.workspaceRoot,
    signal: config.signal,
    timeout: config.limits?.timeoutMs ?? 15_000,
  });

  if (result.exitCode !== 0 && !result.stdout) {
    const hint = result.stderr.includes('not logged in') || result.stderr.includes('not found')
      ? ' (Is `gh` installed and authenticated? Run `gh auth status`.)'
      : '';
    return `gh error (exit ${result.exitCode}): ${result.stderr.trim()}${hint}`;
  }

  return [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
}

export function createGitHubTools(config: ToolConfig): Tool<string>[] {

  // ── read-only ─────────────────────────────────────────────────────────────

  const gh_list_issues = new Tool<string>({
    name: 'gh_list_issues',
    description: 'List GitHub issues for the current repository.',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Issue state. Default: open' },
        label: { type: 'string', description: 'Filter by label' },
        limit: { type: 'number', description: 'Max results. Default: 30' },
      },
      required: [],
    } satisfies ToolInputSchema,
    execute: async ({ state = 'open', label, limit = 30 }) => {
      try {
        const args = ['issue', 'list', '--state', String(state), '--limit', String(limit)];
        if (label) args.push('--label', String(label));
        return await gh(args, config);
      } catch (err) {
        return `Error: ${safe(err)}`;
      }
    },
  });

  const gh_view_issue = new Tool<string>({
    name: 'gh_view_issue',
    description: 'View the details, body, and comments of a GitHub issue.',
    inputSchema: {
      type: 'object',
      properties: {
        number: { type: 'number', description: 'Issue number' },
      },
      required: ['number'],
    } satisfies ToolInputSchema,
    execute: async ({ number }) => {
      try {
        return await gh(['issue', 'view', String(number), '--comments'], config);
      } catch (err) {
        return `Error: ${safe(err)}`;
      }
    },
  });

  const gh_list_prs = new Tool<string>({
    name: 'gh_list_prs',
    description: 'List pull requests for the current repository.',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['open', 'closed', 'merged', 'all'], description: 'PR state. Default: open' },
        limit: { type: 'number', description: 'Max results. Default: 20' },
      },
      required: [],
    } satisfies ToolInputSchema,
    execute: async ({ state = 'open', limit = 20 }) => {
      try {
        return await gh(['pr', 'list', '--state', String(state), '--limit', String(limit)], config);
      } catch (err) {
        return `Error: ${safe(err)}`;
      }
    },
  });

  const gh_view_pr = new Tool<string>({
    name: 'gh_view_pr',
    description: 'View a pull request\'s details, description, and review comments.',
    inputSchema: {
      type: 'object',
      properties: {
        number: { type: 'number', description: 'PR number. Omit to view the PR for the current branch.' },
      },
      required: [],
    } satisfies ToolInputSchema,
    execute: async ({ number }) => {
      try {
        const args = ['pr', 'view', '--comments'];
        if (number) args.push(String(number));
        return await gh(args, config);
      } catch (err) {
        return `Error: ${safe(err)}`;
      }
    },
  });

  const gh_diff = new Tool<string>({
    name: 'gh_diff',
    description: 'Show the diff for a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        number: { type: 'number', description: 'PR number. Omit for the current branch PR.' },
      },
      required: [],
    } satisfies ToolInputSchema,
    execute: async ({ number }) => {
      try {
        const args = ['pr', 'diff'];
        if (number) args.push(String(number));
        return await gh(args, config);
      } catch (err) {
        return `Error: ${safe(err)}`;
      }
    },
  });

  // ── state-changing (behind approval) ─────────────────────────────────────

  const gh_create_pr_spec: ToolSpec = {
    name: 'gh_create_pr',
    description: 'Create a pull request for the current branch.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'PR title' },
        body: { type: 'string', description: 'PR description (markdown)' },
        base: { type: 'string', description: 'Base branch. Default: repo default branch' },
        draft: { type: 'boolean', description: 'Open as draft PR' },
      },
      required: ['title', 'body'],
    },
    execute: async ({ title, body, base, draft }) => {
      try {
        const args = ['pr', 'create', '--title', String(title), '--body', String(body)];
        if (base) args.push('--base', String(base));
        if (draft) args.push('--draft');
        return await gh(args, config);
      } catch (err) {
        return `Error: ${safe(err)}`;
      }
    },
  };

  const gh_comment_spec: ToolSpec = {
    name: 'gh_comment',
    description: 'Post a comment on a GitHub issue or pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        number: { type: 'number', description: 'Issue or PR number' },
        type: { type: 'string', enum: ['issue', 'pr'], description: 'Whether this is an issue or PR' },
        body: { type: 'string', description: 'Comment body (markdown)' },
      },
      required: ['number', 'type', 'body'],
    },
    execute: async ({ number, type, body }) => {
      try {
        const noun = String(type) === 'pr' ? 'pr' : 'issue';
        return await gh([noun, 'comment', String(number), '--body', String(body)], config);
      } catch (err) {
        return `Error: ${safe(err)}`;
      }
    },
  };

  const gh_create_pr = withApproval(
    gh_create_pr_spec,
    config.approval,
    ({ title, body, base, draft }) => ({
      toolName: 'gh_create_pr',
      description: `Create PR: ${title}`,
      detail: `Title: ${title}\nBase: ${base ?? 'default'}\nDraft: ${draft ?? false}\n\n${body}`,
    }),
    config.signal,
  );

  const gh_comment = withApproval(
    gh_comment_spec,
    config.approval,
    ({ number, type, body }) => ({
      toolName: 'gh_comment',
      description: `Comment on ${type} #${number}`,
      detail: String(body),
    }),
    config.signal,
  );

  return [gh_list_issues, gh_view_issue, gh_list_prs, gh_view_pr, gh_diff, gh_create_pr, gh_comment];
}
