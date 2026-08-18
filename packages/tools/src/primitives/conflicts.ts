/**
 * Merge-conflict marker parsing and resolution.
 *
 * Pure text operations only — no git, no filesystem. `conflict-tools.ts` is
 * the layer that finds conflicted files and commit metadata; this is what
 * turns `<<<<<<< / ======= / >>>>>>>` markers into addressable hunks and back.
 */

import { createHash } from 'node:crypto';

export interface ConflictHunk {
  /** 1-indexed line of the `<<<<<<<` marker. */
  startLine: number;
  /** 1-indexed line of the `>>>>>>>` marker. */
  endLine: number;
  /** Text after `<<<<<<< ` — usually "HEAD" or a branch name. */
  oursLabel: string;
  /** Text after `>>>>>>> ` — usually a branch or commit name. */
  theirsLabel: string;
  oursText: string;
  theirsText: string;
  /** Present only for diff3-style markers (`merge.conflictStyle=diff3`). */
  baseText?: string;
}

const OURS_MARKER = /^<{7}(?:\s(.*))?$/;
const BASE_MARKER = /^\|{7}(?:\s(.*))?$/;
const SPLIT_MARKER = /^={7}$/;
const THEIRS_MARKER = /^>{7}(?:\s(.*))?$/;

/**
 * Every conflict hunk in `content`, in file order.
 *
 * A malformed trailing marker (file truncated mid-conflict) stops parsing at
 * that point rather than throwing — better to report the hunks that did
 * parse than fail the whole file over a partial one.
 */
export function parseConflicts(content: string): ConflictHunk[] {
  const lines = content.split('\n');
  const hunks: ConflictHunk[] = [];
  let i = 0;

  while (i < lines.length) {
    const oursMatch = OURS_MARKER.exec(lines[i]);
    if (!oursMatch) { i++; continue; }

    const startLine = i + 1;
    const oursLabel = oursMatch[1] ?? '';
    i++;

    const oursLines: string[] = [];
    while (i < lines.length && !BASE_MARKER.test(lines[i]) && !SPLIT_MARKER.test(lines[i])) {
      oursLines.push(lines[i]);
      i++;
    }

    let baseLines: string[] | undefined;
    if (i < lines.length && BASE_MARKER.test(lines[i])) {
      baseLines = [];
      i++;
      while (i < lines.length && !SPLIT_MARKER.test(lines[i])) {
        baseLines.push(lines[i]);
        i++;
      }
    }

    if (i >= lines.length) break; // no closing ======= — malformed, stop here
    i++; // skip =======

    const theirsLines: string[] = [];
    while (i < lines.length && !THEIRS_MARKER.test(lines[i])) {
      theirsLines.push(lines[i]);
      i++;
    }

    if (i >= lines.length) break; // no closing >>>>>>> — malformed, stop here
    const theirsMatch = THEIRS_MARKER.exec(lines[i])!;
    const theirsLabel = theirsMatch[1] ?? '';
    const endLine = i + 1;
    i++;

    hunks.push({
      startLine,
      endLine,
      oursLabel,
      theirsLabel,
      oursText: oursLines.join('\n'),
      theirsText: theirsLines.join('\n'),
      ...(baseLines ? { baseText: baseLines.join('\n') } : {}),
    });
  }

  return hunks;
}

export type Resolution = 'ours' | 'theirs' | 'both';

/**
 * `content` with `hunk` replaced by the chosen side(s), markers and all
 * removed. `both` keeps ours first, then theirs — the order they already
 * appear in the file.
 */
export function applyResolution(content: string, hunk: ConflictHunk, choice: Resolution): string {
  const lines = content.split('\n');
  const parts = choice === 'ours' ? [hunk.oursText]
    : choice === 'theirs' ? [hunk.theirsText]
    : [hunk.oursText, hunk.theirsText];
  const replacement = parts.filter((s) => s.length > 0).join('\n');
  const replacementLines = replacement.length > 0 ? replacement.split('\n') : [];
  lines.splice(hunk.startLine - 1, hunk.endLine - hunk.startLine + 1, ...replacementLines);
  return lines.join('\n');
}

/**
 * A short, stable id for a hunk: stable because it hashes the hunk's own
 * content rather than its position, so resolving one conflict in a file
 * never invalidates the id of another one that hasn't shifted line numbers
 * yet — only the *reported* line numbers change, and those are refreshed on
 * every `list_conflicts` call.
 */
export function hashConflict(filePath: string, hunk: ConflictHunk): string {
  const key = `${filePath}\n${hunk.oursText}\n${hunk.theirsText}\n${hunk.baseText ?? ''}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}
