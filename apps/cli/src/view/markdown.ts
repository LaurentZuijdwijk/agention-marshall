// ── markdown (deliberately not a real parser) ─────────────────────────────────
//
// A line-oriented block scanner plus one inline regex pass. No AST, no
// dependency, no lookahead across the document.
//
// Two reasons to keep it this dumb:
//
//   1. We render into a terminal, where most of CommonMark has nowhere to go —
//      no images, no tables worth the trouble, no nested block structure that
//      survives an 80-column viewport.
//   2. Assistant output is *streamed*. Every token re-parses a document whose
//      last line is usually half-written. A line scanner degrades gracefully:
//      an unterminated fence renders as code, an unclosed `**` renders as
//      literal asterisks, and both fix themselves on the next token. A real
//      parser would either throw or thrash between interpretations.

export interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: boolean;
  /** Trailing URL of a link — rendered as chrome, not content. */
  dim?: boolean;
}

export type Block =
  | { kind: 'blank' }
  | { kind: 'rule' }
  | { kind: 'heading'; level: number; spans: Span[] }
  | { kind: 'code'; lang: string; lines: string[] }
  | { kind: 'quote'; spans: Span[] }
  | { kind: 'item'; indent: number; marker: string; spans: Span[] }
  | { kind: 'para'; spans: Span[] };

// ── inline ────────────────────────────────────────────────────────────────────

// Alternation order is the precedence order: code wins over everything (so
// `**x**` inside backticks stays literal), and `**bold**` is tried before
// `*italic*`. Every branch is bounded to a single line and forbids its own
// delimiter, so there is no backtracking blowup on pathological input.
//
// `_underscore_` italics are intentionally absent: snake_case identifiers are
// everywhere in this app's output and would be mangled constantly.
const INLINE_RE =
  /`([^`\n]+)`|\*\*([^*\n]+)\*\*|~~([^~\n]+)~~|\*([^*\n]+)\*|\[([^\]\n]*)\]\(([^)\n]*)\)/g;

/** Split one line into styled spans. Unmatched delimiters stay literal. */
export function parseInline(text: string): Span[] {
  const spans: Span[] = [];
  let last = 0;

  // Fresh index per call — INLINE_RE is global and shared.
  INLINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) spans.push({ text: text.slice(last, m.index) });

    const [, code, bold, strike, italic, label, url] = m;
    if (code !== undefined)        spans.push({ text: code, code: true });
    else if (bold !== undefined)   spans.push({ text: bold, bold: true });
    else if (strike !== undefined) spans.push({ text: strike, strike: true });
    else if (italic !== undefined) spans.push({ text: italic, italic: true });
    else {
      // Links keep the URL visible — a terminal has nothing to click.
      spans.push({ text: label || url, link: true });
      if (label && url && label !== url) spans.push({ text: ` (${url})`, dim: true });
    }

    last = m.index + m[0].length;
  }

  if (last < text.length) spans.push({ text: text.slice(last) });
  return spans;
}

// ── blocks ────────────────────────────────────────────────────────────────────

const FENCE   = /^\s*(?:```|~~~)(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE    = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE   = /^\s*>\s?(.*)$/;
const ITEM    = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

/** Two spaces per nesting level, capped so deep lists stay readable. */
const nestingOf = (leading: string) => Math.min(Math.floor(leading.length / 2), 4);

export function parseBlocks(text: string): Block[] {
  const lines = text.split('\n');
  const blocks: Block[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      // A missing closing fence just runs to the end — the common case while
      // a code block is still streaming in.
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++]);
      blocks.push({ kind: 'code', lang: fence[1].trim(), lines: body });
      continue;
    }

    if (line.trim() === '') { blocks.push({ kind: 'blank' }); continue; }
    if (RULE.test(line))    { blocks.push({ kind: 'rule' });  continue; }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        kind: 'heading',
        level: heading[1].length,
        spans: parseInline(heading[2].replace(/\s+#+\s*$/, '')),
      });
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) { blocks.push({ kind: 'quote', spans: parseInline(quote[1]) }); continue; }

    const item = ITEM.exec(line);
    if (item) {
      blocks.push({
        kind: 'item',
        indent: nestingOf(item[1]),
        // Bullet characters are cosmetic; numbers carry meaning, so keep them.
        marker: /^\d/.test(item[2]) ? item[2] : '•',
        spans: parseInline(item[3]),
      });
      continue;
    }

    // Paragraphs stay one block per line: the model's own line breaks are
    // meaningful in a terminal, so we don't reflow them the way HTML would.
    blocks.push({ kind: 'para', spans: parseInline(line) });
  }

  return blocks;
}
