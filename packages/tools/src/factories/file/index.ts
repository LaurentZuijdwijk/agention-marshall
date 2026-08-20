import { Tool } from '@agentionai/agents/core';
import { DEFAULT_MAX_FILE_BYTES } from '../../primitives/capped-read.js';
import { buildReadFile, createReadGateTools } from './read-gate.js';
import { buildListDir } from './list-dir.js';
import { buildSearch, MAX_SEARCH_RESULTS } from './search.js';
import type { ToolConfig, DedupeCache } from '../../types.js';

/** Read-only file tools for use in context sub-agents. */
export function createReadOnlyFileTools(
  workspaceRoot: string,
  limits: ToolConfig['limits'] = {},
  dedupeCache?: DedupeCache,
): Tool<string>[] {
  const maxFileBytes = limits?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxSearchResults = limits?.maxSearchResults ?? MAX_SEARCH_RESULTS;
  return [
    // A throwaway read set: with no write tools on this belt there is nothing
    // to gate, so nothing needs it to outlive the call.
    buildReadFile(workspaceRoot, maxFileBytes, new Map(), dedupeCache),
    buildListDir(workspaceRoot),
    buildSearch(workspaceRoot, maxSearchResults),
  ];
}

export function createFileTools(config: ToolConfig, dedupeCache?: DedupeCache): Tool<string>[] {
  const { workspaceRoot, limits = {} } = config;
  const maxSearchResults = limits.maxSearchResults ?? MAX_SEARCH_RESULTS;

  const { read_file, write_file, edit_file } = createReadGateTools(config, dedupeCache);
  const list_dir = buildListDir(workspaceRoot);
  const search = buildSearch(workspaceRoot, maxSearchResults);

  return [read_file, list_dir, search, write_file, edit_file];
}
