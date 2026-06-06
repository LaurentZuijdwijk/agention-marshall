export type ApprovalDecision = 'approve' | 'deny' | 'always';

export interface DedupeCacheEntry {
  hash: string;
  lineCount: number;
}

export interface DedupeCache {
  get(path: string): DedupeCacheEntry | undefined;
  set(path: string, entry: DedupeCacheEntry): void;
  clear(): void;
}

export function createDedupeCache(): DedupeCache {
  const map = new Map<string, DedupeCacheEntry>();
  return {
    get: (p) => map.get(p),
    set: (p, e) => { map.set(p, e); },
    clear: () => map.clear(),
  };
}

export interface ApprovalRequest {
  toolName: string;
  /** One-line summary shown in the approval prompt */
  description: string;
  /** Full detail: diff for file edits, command line for shell */
  detail: string;
}

export type ApprovalFn = (request: ApprovalRequest) => Promise<ApprovalDecision>;

export interface Limits {
  /** Max bytes for file reads. Default: 256 KiB */
  maxFileBytes?: number;
  /** Max bytes captured from shell stdout/stderr each. Default: 64 KiB */
  maxOutputBytes?: number;
  /** Shell command timeout in ms. Default: 30 s */
  timeoutMs?: number;
  /** Max grep results returned. Default: 200 */
  maxSearchResults?: number;
}

export type CommandPolicy =
  | { mode: 'allowlist'; patterns: RegExp[] }
  | { mode: 'denylist'; patterns: RegExp[] }
  | { mode: 'none' };

export interface ToolConfig {
  workspaceRoot: string;
  approval: ApprovalFn;
  signal?: AbortSignal;
  commandPolicy?: CommandPolicy;
  limits?: Limits;
}

/** Plain tool spec — used by withApproval so it doesn't need Tool internals */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<string>;
}
