export type {
  ToolConfig,
  ApprovalFn,
  ApprovalDecider,
  ApprovalDecision,
  ApprovalRequest,
  ToolCaller,
  ToolSource,
  Limits,
  CommandPolicy,
  ToolSpec,
  DedupeCache,
  DedupeCacheEntry,
} from './types.js';
export { createDedupeCache } from './types.js';

export { resolveInWorkspace, PathEscapeError } from './primitives/resolve.js';
export { atomicWrite } from './primitives/atomic-write.js';
export { cappedRead, DEFAULT_MAX_FILE_BYTES } from './primitives/capped-read.js';
export {
  spawnSandboxed,
  scrubbedEnv,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
} from './primitives/spawn.js';
export {
  createBackgroundJobs,
  DEFAULT_BACKGROUND_TIMEOUT_MS,
} from './primitives/background.js';
export type {
  BackgroundJob,
  BackgroundJobs,
  BackgroundJobsOptions,
  JobOutput,
  JobStatus,
  StartJobOptions,
} from './primitives/background.js';

export { withApproval } from './factories/approval.js';
export { createFileTools, createReadOnlyFileTools } from './factories/file-tools.js';
export { createShellTool, DEFAULT_COMMAND_POLICY } from './factories/shell-tool.js';
export { createJobTools, summarise as summariseJob, formatOutput as formatJobOutput } from './factories/job-tools.js';
export {
  adaptMcpTools,
  namespaceMcpTool,
  stringifyResult as stringifyMcpResult,
  DEFAULT_MCP_TIMEOUT_MS,
} from './factories/mcp-tools.js';
export type { McpToolOptions } from './factories/mcp-tools.js';
export { createScratchTools } from './factories/scratch-tools.js';
export { createGitHubTools } from './factories/github-tools.js';
