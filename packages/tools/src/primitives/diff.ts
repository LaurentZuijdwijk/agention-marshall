/**
 * Line diffs for approval prompts.
 *
 * The security property this exists for: what a reviewer is shown must scale
 * with the size of the *change*, not the size of the file. `write_file` used to
 * render the first 800 characters of its new content, which meant a change past
 * that point was simply never displayed — an agent wanting to alter line 200 of
 * a long file could avoid `edit_file`'s diff entirely by rewriting the whole
 * file, and the panel would show an unchanged, benign-looking prefix.
 *
 * With a diff, an approval prompt that looks empty means nothing changed.
 */

export interface DiffStats {
  added: number;
  removed: number;
  unchanged: number;
}

/** Lines of context kept either side of a change. */
const CONTEXT_LINES = 3;

/**
 * Ceiling on the LCS table. Beyond this the two versions have so little in
 * common that a line-by-line alignment is neither cheap nor informative, so the
 * differing region is reported as one wholesale replacement instead.
 */
const MAX_LCS_CELLS = 2_000_000;

type Op = { kind: 'same' | 'add' | 'remove'; line: string };

/**
 * Longest common subsequence over lines, for the region that actually differs.
 *
 * Only ever called on the middle left after identical prefixes and suffixes are
 * stripped, which is what keeps it affordable: an ordinary edit leaves a middle
 * of a few lines regardless of how long the file is.
 */
function lcsOps(before: string[], after: string[]): Op[] {
  const n = before.length;
  const m = after.length;

  if (n * m > MAX_LCS_CELLS) {
    return [
      ...before.map((line): Op => ({ kind: 'remove', line })),
      ...after.map((line): Op => ({ kind: 'add', line })),
    ];
  }

  // table[i][j] = LCS length of before[i..] and after[j..]
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = before[i] === after[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ kind: 'same', line: before[i] });
      i++; j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ kind: 'remove', line: before[i] });
      i++;
    } else {
      ops.push({ kind: 'add', line: after[j] });
      j++;
    }
  }
  while (i < n) ops.push({ kind: 'remove', line: before[i++] });
  while (j < m) ops.push({ kind: 'add', line: after[j++] });
  return ops;
}

/** Every op needed to turn `before` into `after`, cheapest parts first. */
export function diffLines(before: string, after: string): Op[] {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');

  // Identical head and tail are stripped before doing any real work. This is
  // both the speed-up and the reason a one-line change in a huge file reports
  // as a one-line change.
  let head = 0;
  while (head < beforeLines.length && head < afterLines.length
    && beforeLines[head] === afterLines[head]) head++;

  let tail = 0;
  while (tail < beforeLines.length - head && tail < afterLines.length - head
    && beforeLines[beforeLines.length - 1 - tail] === afterLines[afterLines.length - 1 - tail]) tail++;

  return [
    ...beforeLines.slice(0, head).map((line): Op => ({ kind: 'same', line })),
    ...lcsOps(
      beforeLines.slice(head, beforeLines.length - tail),
      afterLines.slice(head, afterLines.length - tail),
    ),
    ...beforeLines.slice(beforeLines.length - tail).map((line): Op => ({ kind: 'same', line })),
  ];
}

export function diffStats(ops: Op[]): DiffStats {
  const stats: DiffStats = { added: 0, removed: 0, unchanged: 0 };
  for (const op of ops) {
    if (op.kind === 'add') stats.added++;
    else if (op.kind === 'remove') stats.removed++;
    else stats.unchanged++;
  }
  return stats;
}

/** `+2 −1, 480 unchanged` — the shape of a write, before you read a line of it. */
export function describeDiff(stats: DiffStats): string {
  if (stats.added === 0 && stats.removed === 0) return 'no changes';
  return `+${stats.added} −${stats.removed}, ${stats.unchanged} unchanged`;
}

/**
 * A unified-style rendering of `before` → `after`, showing only what changed
 * plus a little context.
 *
 * `maxLines` truncates, but truncation here is safe in a way the old
 * content-prefix was not: what gets cut is further *changes*, and the reader is
 * told how many. A short diff means a small change, never a hidden one.
 */
export function formatFileDiff(
  path: string,
  before: string,
  after: string,
  maxLines = 40,
): { text: string; stats: DiffStats } {
  const ops = diffLines(before, after);
  const stats = diffStats(ops);

  if (stats.added === 0 && stats.removed === 0) {
    return { text: `--- ${path}\n+++ ${path}\n(no changes — the new content is identical)`, stats };
  }

  // Which lines are worth printing: every change, plus CONTEXT_LINES either side.
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, index) => {
    if (op.kind === 'same') return;
    const from = Math.max(0, index - CONTEXT_LINES);
    const to = Math.min(ops.length - 1, index + CONTEXT_LINES);
    for (let k = from; k <= to; k++) keep[k] = true;
  });

  const out: string[] = [`--- ${path}`, `+++ ${path}`];
  let printed = 0;
  let skipped = 0;
  let hiddenChanges = 0;
  let truncated = false;

  for (let index = 0; index < ops.length; index++) {
    if (!keep[index]) { skipped++; continue; }

    if (printed >= maxLines) {
      if (ops[index].kind !== 'same') { hiddenChanges++; truncated = true; }
      continue;
    }

    if (skipped > 0) {
      out.push(`@@ ${skipped} unchanged line${skipped === 1 ? '' : 's'} @@`);
      skipped = 0;
    }

    const op = ops[index];
    out.push(`${op.kind === 'add' ? '+' : op.kind === 'remove' ? '-' : ' '} ${op.line}`);
    printed++;
  }

  if (truncated) {
    out.push(`@@ ${hiddenChanges} further changed line${hiddenChanges === 1 ? '' : 's'} not shown @@`);
  }

  return { text: out.join('\n'), stats };
}
