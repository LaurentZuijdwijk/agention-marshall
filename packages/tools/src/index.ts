export type {
  ToolConfig,
  ApprovalFn,
  ApprovalDecision,
  ApprovalRequest,
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
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
} from './primitives/spawn.js';

export { withApproval } from './factories/approval.js';
export { createFileTools } from './factories/file-tools.js';
export { createShellTool, DEFAULT_COMMAND_POLICY } from './factories/shell-tool.js';
export { createScratchTools } from './factories/scratch-tools.js';
export { createGitHubTools } from './factories/github-tools.js';
