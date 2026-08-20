import { Tool } from '@agentionai/agents/core';
import type { ToolInputSchema } from '@agentionai/agents/core';
import { readdir, stat } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { resolveInWorkspace } from '../../primitives/resolve.js';
import { cappedReadPart } from '../../primitives/capped-read.js';
import type { CappedReadResult } from '../../primitives/capped-read.js';
import { splitLines } from '../../primitives/line-window.js';
import { safe } from '../../primitives/tool-error.js';

// Generated output and dependency trees, which answer almost every pattern with
// a copy of the thing you were looking for. Not `.gitignore`-aware — that would
// be the principled version — so this is the common set across the ecosystems
// the agent is pointed at most.
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.next', 'dist', 'build', 'coverage',
  '.cache', '.turbo', '.svelte-kit', '__pycache__', '.venv',
  'target', 'out', 'vendor', '.gradle', '.tox', '.mypy_cache',
  '.pytest_cache', '.nuxt', '.parcel-cache', 'Pods', '.terraform',
]);

export const MAX_SEARCH_RESULTS = 200;
const MAX_SEARCH_FILE_BYTES = 256 * 1024;
/**
 * How much of a matched line to show.
 *
 * A "line" in a minified bundle or a one-line JSON dump is the whole file, so
 * without this one hit can return a quarter of a megabyte — and the match
 * itself is buried in the middle of it, which is the part the caller wanted.
 * The window is centred on the match rather than taken from the start of the
 * line, for the same reason.
 */
const MAX_MATCH_CHARS = 400;

function clipMatch(line: string, at: number): string {
  if (line.length <= MAX_MATCH_CHARS) return line.trim();
  const start = Math.max(0, Math.min(at - Math.floor(MAX_MATCH_CHARS / 2), line.length - MAX_MATCH_CHARS));
  const end = start + MAX_MATCH_CHARS;
  return `${start > 0 ? '…' : ''}${line.slice(start, end).trim()}${end < line.length ? '…' : ''}`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function* walkFiles(dir: string): AsyncGenerator<string> {
  const info = await stat(dir);
  if (info.isFile()) {
    yield dir;
    return;
  }

  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Tested here rather than against every entry: these are directory names,
      // and a plain file that happens to be called `build` or `vendor` is a file
      // like any other — skipping it searched nothing and said nothing.
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walkFiles(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

export function buildSearch(workspaceRoot: string, maxSearchResults: number): Tool<string> {
  return new Tool<string>({
    name: 'search',
    // Kept short deliberately: this ships on every request. Anything the tool
    // can say at the moment it matters — what it skipped, why a glob excluded
    // everything, that results were cut — is said in the result instead.
    description:
      'Search file contents (not names) with a regex, line by line. Up to 200 matches as ' +
      '"path:line: text". A plain name matches case-insensitively across separators ' +
      '("file-tools" finds "fileTools"); regex syntax is exact and case-sensitive. ' +
      'Skips binaries and generated dirs (node_modules, dist, …).',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regex, or a plain name' },
        path: {
          type: 'string',
          description: 'Directory or file to search within. Defaults to workspace root.',
        },
        fileGlob: {
          type: 'string',
          description: 'Filter by file name: substring (".ts") or suffix ("*.ts"). Not a path — use `path` for directories.',
        },
      },
      required: ['pattern'],
    } satisfies ToolInputSchema,
    execute: async ({ pattern, path = '.', fileGlob }) => {
      try {
        const resolved = resolveInWorkspace(workspaceRoot, String(path));
        let regex: RegExp;
        const requestedPattern = String(pattern);
        try {
          // Keep explicit regexes exact; make ordinary identifier/name searches
          // forgiving because agents and humans routinely vary case and separators.
          // `\w` already excludes every regex metacharacter this needs to rule
          // out, so the class alone is the whole check.
          const isPlainName = /^[\w\s-]+$/.test(requestedPattern);
          if (isPlainName) {
            // The joiner is `*`, not `+`: a bare case change ("fileTools") has no
            // separator character at all, so demanding one would miss it. The same
            // `*` also lets "file-tools" match a run-together "filetools" — looser
            // than the four conventions named above, but still a plausible way to
            // type the identifier, and not worth the regex complexity of telling
            // "no separator" apart from "case-changed" under a case-insensitive match.
            // A pattern made entirely of separators (e.g. "-") splits to no
            // words at all; joining an empty list gives the empty regex,
            // which matches every position on every line. Fall back to a
            // literal search for the pattern itself rather than let that
            // through.
            const words = requestedPattern.split(/[\s_-]+/).filter(Boolean).map(escapeRegex);
            regex = new RegExp(words.length > 0 ? words.join('[\\s_-]*') : escapeRegex(requestedPattern), 'gi');
          } else {
            regex = new RegExp(requestedPattern, 'g');
          }
        } catch (err) {
          return `Error: Invalid regex: ${safe(err)}`;
        }
        const glob = fileGlob ? String(fileGlob) : null;
        const matchesFileGlob = (filePath: string): boolean => {
          if (!glob) return true;
          const name = basename(filePath);
          // Accept the shell-style suffix form agents commonly send ("*.ts"),
          // as well as the documented substring form (".ts").
          if (glob.startsWith('*.')) return name.endsWith(glob.slice(1));
          return name.includes(glob);
        };
        const results: string[] = [];
        let globMatchedFiles = 0;
        let searchedFiles = 0;
        let skippedBinary = 0;
        const partiallySearched: string[] = [];
        let truncated = false;

        for await (const filePath of walkFiles(resolved)) {
          if (!matchesFileGlob(filePath)) continue;
          globMatchedFiles++;
          let part: CappedReadResult;
          // Capped: search walks the whole workspace, so an uncapped read here
          // makes one oversized log or dataset the peak memory of every search.
          // `cappedReadPart` rather than `cappedRead` because the latter states
          // the truncation *inside* the content, where it is indistinguishable
          // from a line of the file — searching for a word in the marker used to
          // report a match at a line number the file does not have.
          try { part = await cappedReadPart(filePath, MAX_SEARCH_FILE_BYTES); } catch { continue; }
          // What grep does, for the same reason: the bytes decode to
          // replacement characters, and a match in them is a line of mojibake
          // in the model's context that it can neither read nor act on.
          if (part.binary) { skippedBinary++; continue; }
          searchedFiles++;
          if (part.truncated) partiallySearched.push(relative(workspaceRoot, filePath));

          const lines = splitLines(part.content);
          for (let i = 0; i < lines.length; i++) {
            regex.lastIndex = 0;
            // `exec` rather than `test`: the match offset is what lets a hit in
            // a very long line be shown centred on the match.
            const found = regex.exec(lines[i]);
            if (found) {
              results.push(`${relative(workspaceRoot, filePath)}:${i + 1}: ${clipMatch(lines[i], found.index)}`);
              if (results.length > maxSearchResults) {
                truncated = true;
                break;
              }
            }
          }
          if (truncated) break;
        }

        // Said whether or not anything matched: "no matches" in a file that was
        // only read up to the cap is not the same claim as "no matches", and a
        // caller that cannot tell them apart stops looking.
        const notes: string[] = [];
        if (truncated) notes.push(`[...truncated at ${maxSearchResults} matches...]`);
        if (partiallySearched.length > 0) {
          const named = partiallySearched.slice(0, 5).join(', ');
          const rest = partiallySearched.length > 5 ? ` and ${partiallySearched.length - 5} more` : '';
          notes.push(`[searched only the first ${Math.floor(MAX_SEARCH_FILE_BYTES / 1024)} KiB of ${named}${rest} — matches past that are not reported]`);
        }
        if (skippedBinary > 0) notes.push(`[skipped ${skippedBinary} binary file${skippedBinary === 1 ? '' : 's'}]`);

        // A fileGlob that matches nothing returns the same "no matches" as a
        // pattern that is genuinely absent, and the two call for opposite next
        // steps. `src/*.ts` is the common way to land here — the glob is tested
        // against the file name, so any path fragment excludes every file.
        if (glob && globMatchedFiles === 0) {
          return (
            `No files matched fileGlob ${JSON.stringify(glob)}, so nothing was searched. ` +
            `It is matched against the file name only — use a substring (".ts") or a suffix ` +
            `("*.ts"), and scope to a directory with \`path\` instead.`
          );
        }

        if (results.length === 0) {
          const scope = glob ? ` (fileGlob ${JSON.stringify(glob)}, ${searchedFiles} files searched)` : ` (${searchedFiles} files searched)`;
          return [`No matches found${scope}.`, ...notes].join('\n');
        }
        if (truncated) results.length = maxSearchResults;
        return [...results, ...notes].join('\n');
      } catch (err) {
        return `Error: ${safe(err)}`;
      }
    },
  });
}
