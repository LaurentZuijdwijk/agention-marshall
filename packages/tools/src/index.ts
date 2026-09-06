export type {
  ToolConfig,
  AskFn,
  AskRequest,
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
export { createKeyedLock } from './primitives/keyed-lock.js';
export type { KeyedLock } from './primitives/keyed-lock.js';
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
export { createAskTool } from './factories/ask-tool.js';
export { createFileTools, createReadOnlyFileTools } from './factories/file/index.js';
export { createShellTool, DEFAULT_COMMAND_POLICY } from './factories/shell-tool.js';
export { createJobTools, summarise as summariseJob, formatOutput as formatJobOutput } from './factories/job-tools.js';
export {
  adaptMcpTools,
  namespaceMcpTool,
  stringifyResult as stringifyMcpResult,
  multimodalMcpResult,
  DEFAULT_MCP_TIMEOUT_MS,
  SUPPORTED_IMAGE_MIME_TYPES,
  MAX_TOOL_IMAGE_BYTES,
} from './factories/mcp-tools.js';
export type { McpToolOptions, McpMultimodalResult } from './factories/mcp-tools.js';
export { createScratchTools } from './factories/scratch-tools.js';
export { createGitHubTools } from './factories/github-tools.js';
export { createConflictTools } from './factories/conflict-tools.js';
export { parseConflicts, applyResolution, hashConflict } from './primitives/conflicts.js';
export type { ConflictHunk, Resolution } from './primitives/conflicts.js';
