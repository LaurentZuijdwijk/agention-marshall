// ── applying a batch of exact-string edits to one file ──────────────────────
//
// Split out from the tool so the matching rules are testable without a
// workspace, an approval chain or a read gate in the way.
//
// Why batching exists at all: a benchmarked multi-file migration showed the
// model spending 143 separate `edit_file` calls on 28 files — four to six
// disjoint regions each — where the same work batched is 28 calls. The cost of
// a call is not its payload (measured: runs whose payloads were *larger* emitted
// 60-108% fewer output tokens than runs with many small ones) but the per-call
// envelope, the repeated path, and the model's own preamble around each one.

/**
 * One replacement, addressed either by content or by line range.
 *
 * `oldString` is self-validating — it either matches once or it doesn't — and
 * since `read_file` now renders raw by default it can usually be copied
 * straight out of what was read. That default is why: while reads carried a
 * `12 | ` gutter, every `oldString` had to be *reconstructed* rather than
 * copied — strip the gutter, get the whitespace right, add enough context to
 * be unique — and reading the model's own reasoning traces on a 28-file
 * migration showed it drafting each `oldString`/`newString` pair in full
 * inside `<think>` before emitting the same text again as arguments, paying
 * for the payload twice, then reasoning further to repair edits it had
 * malformed that way. See `renderLines` in `read-gate.ts`.
 *
 * `startLine`/`endLine` remain for the case where a gutter *is* switched on
 * (`Limits.readLineNumbers`) or the span is simply easier to name by number:
 * they address it using the numbers already in front of it, with nothing to
 * reconstruct. The trade is that line numbers are only meaningful against the
 * version that was read, so a line-addressed edit is gated on the file being
 * unchanged since — see `read-gate.ts`.
 */
export type EditRequest =
  | { oldString: string; newString: string; startLine?: undefined; endLine?: undefined }
  | { startLine: number; endLine: number; newString: string; oldString?: undefined };

export interface EditFailure {
  /** Index into the requested edits, so a batch can say which one broke. */
  index: number;
  reason: 'not-found' | 'ambiguous' | 'overlap' | 'bad-range';
  /** Occurrences found, for `ambiguous`. */
  count?: number;
  /** Lines in the file, for `bad-range`. */
  lineCount?: number;
}

export type ApplyEditsResult =
  | { ok: true; content: string; applied: number; fuzzy: number }
  | { ok: false; failures: EditFailure[] };

/**
 * Characters that models substitute without meaning to.
 *
 * A model copies `oldString` out of what `read_file` rendered, and along the
 * way a quote can come back curled or a hyphen widened. The text it is matching
 * against is unchanged, so an exact match misses and the whole edit body has to
 * be emitted again — the single most expensive kind of wasted output token.
 * Each of these maps to exactly one character, so offsets are preserved.
 */
const CHAR_FOLDS = new Map<string, string>([
  ['‘', "'"], ['’', "'"], ['‚', "'"], ['‛', "'"],
  ['“', '"'], ['”', '"'], ['„', '"'], ['‟', '"'],
  ['‐', '-'], ['‑', '-'], ['‒', '-'], ['–', '-'],
  ['—', '-'], ['―', '-'], ['−', '-'],
  [' ', ' '], [' ', ' '], [' ', ' '], [' ', ' '],
  [' ', ' '], [' ', ' '], [' ', ' '],
]);

/**
 * A normalized copy plus, for every character in it, the index it came from.
 *
 * The map is what makes the fallback safe: a match is found in normalized
 * space, then translated back to real offsets so the bytes actually replaced
 * are the ones in the file. Without it, stripping trailing whitespace would
 * shift every subsequent offset and the edit would land in the wrong place.
 */
function normalizeWithMap(text: string): { normalized: string; map: number[] } {
  const out: string[] = [];
  const map: number[] = [];
  let i = 0;
  while (i <= text.length) {
    let lineEnd = text.indexOf('\n', i);
    if (lineEnd === -1) lineEnd = text.length;
    // Trailing spaces and tabs are dropped; everything else is folded in place.
    let end = lineEnd;
    while (end > i && (text[end - 1] === ' ' || text[end - 1] === '\t')) end--;
    for (let k = i; k < end; k++) {
      out.push(CHAR_FOLDS.get(text[k]) ?? text[k]);
      map.push(k);
    }
    if (lineEnd >= text.length) break;
    out.push('\n');
    map.push(lineEnd);
    i = lineEnd + 1;
  }
  return { normalized: out.join(''), map };
}

function indexesOf(haystack: string, needle: string): number[] {
  if (!needle) return [];
  const found: number[] = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    found.push(at);
  }
  return found;
}

interface Span { index: number; start: number; end: number; newString: string; fuzzy: boolean }

/**
 * Locates every edit against the *original* content, then splices them in from
 * the back.
 *
 * Matching against the original rather than against the running result is what
 * lets a caller describe several changes at once without reasoning about how
 * earlier ones move later offsets. Applying in reverse start order is what
 * makes that true in practice: a replacement only ever shifts text after
 * itself, and by the time it is applied everything after it is already done.
 */
export function applyEdits(original: string, edits: readonly EditRequest[]): ApplyEditsResult {
  const failures: EditFailure[] = [];
  const spans: Span[] = [];
  // Built once, and only if something actually misses.
  let normalizedOriginal: { normalized: string; map: number[] } | undefined;

  // Line starts, computed once and only if something is addressed by line.
  let lineStarts: number[] | undefined;
  const startsOf = (text: string): number[] => {
    const out = [0];
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) out.push(i + 1);
    return out;
  };

  edits.forEach((edit, index) => {
    if (edit.oldString === undefined) {
      lineStarts ??= startsOf(original);
      const { startLine, endLine } = edit;
      // 1-indexed and inclusive, matching the range `read_file`'s header
      // reports (and its gutter, where `Limits.readLineNumbers` turns one on).
      if (!Number.isInteger(startLine) || !Number.isInteger(endLine)
        || startLine < 1 || endLine < startLine || endLine > lineStarts.length) {
        failures.push({ index, reason: 'bad-range', lineCount: lineStarts.length });
        return;
      }
      const start = lineStarts[startLine - 1];
      // Through the end of `endLine`, including its newline where there is one,
      // so replacing a whole line does not weld it to the line below.
      const end = endLine < lineStarts.length ? lineStarts[endLine] : original.length;
      spans.push({ index, start, end, newString: edit.newString, fuzzy: false });
      return;
    }

    const old = edit.oldString;
    const exact = indexesOf(original, old);
    if (exact.length === 1) {
      spans.push({ index, start: exact[0], end: exact[0] + old.length, newString: edit.newString, fuzzy: false });
      return;
    }
    if (exact.length > 1) {
      failures.push({ index, reason: 'ambiguous', count: exact.length });
      return;
    }

    // Exact miss only. A string that matched exactly is never reinterpreted.
    normalizedOriginal ??= normalizeWithMap(original);
    const { normalized, map } = normalizedOriginal;
    const needle = normalizeWithMap(old).normalized;
    const loose = indexesOf(normalized, needle);
    if (loose.length === 1 && needle) {
      const start = map[loose[0]];
      const last = map[loose[0] + needle.length - 1];
      spans.push({ index, start, end: last + 1, newString: edit.newString, fuzzy: true });
      return;
    }
    if (loose.length > 1) failures.push({ index, reason: 'ambiguous', count: loose.length });
    else failures.push({ index, reason: 'not-found' });
  });

  // Overlap is reported against the later edit of the pair, so the message
  // points at the one the caller should merge into its neighbour.
  const ordered = [...spans].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].start < ordered[i - 1].end) {
      const later = ordered[i].index > ordered[i - 1].index ? ordered[i] : ordered[i - 1];
      if (!failures.some(f => f.index === later.index)) failures.push({ index: later.index, reason: 'overlap' });
    }
  }

  if (failures.length) return { ok: false, failures: failures.sort((a, b) => a.index - b.index) };

  let content = original;
  for (const span of [...ordered].reverse()) {
    content = content.slice(0, span.start) + span.newString + content.slice(span.end);
  }
  return { ok: true, content, applied: spans.length, fuzzy: spans.filter(s => s.fuzzy).length };
}
