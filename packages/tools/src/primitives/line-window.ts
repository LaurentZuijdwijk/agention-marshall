import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

export interface LineWindowOptions {
  /** First line to collect (1-indexed, inclusive). Defaults to 1. */
  startLine?: number;
  /** Last line to collect (1-indexed, inclusive). Defaults to the last line. */
  endLine?: number;
  /** Stop collecting once the window would exceed this many bytes. */
  maxBytes?: number;
}

export interface LineWindow {
  /** sha256 of the file's bytes, truncated to 16 hex characters. */
  hash: string;
  /** Size of the file on disk. */
  byteLength: number;
  /** Lines in the whole file. A trailing terminator ends the last line rather
   *  than starting an empty one, so this matches what `wc -l` and grep count. */
  totalLines: number;
  /** The collected window. */
  lines: string[];
  /** Line number of the last collected line; `startLine - 1` if none was. */
  end: number;
  /** The window stopped short of `endLine` because it hit `maxBytes`, or a
   *  line in it was clipped to fit — see `lineClipped` for which. */
  truncated: boolean;
  /**
   * The window's first line was, on its own, longer than `maxBytes` and was
   * cut to fit. Distinct from `truncated` on its own: "read more lines" is
   * the fix for a window that stopped early, but is not the fix here — the
   * file has nothing else to page to, only more of the one line already
   * shown.
   */
  lineClipped: boolean;
}

/**
 * The first `maxBytes` bytes of `text`, cut at a UTF-8 character boundary.
 *
 * A naive byte slice can land mid-character and hand back an invalid tail;
 * backing off to the nearest boundary keeps the clipped line valid UTF-8
 * instead of ending in a replacement character.
 */
function clipToBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let end = Math.max(0, maxBytes);
  // A UTF-8 continuation byte is 10xxxxxx; back off until we're not sitting
  // inside one.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

/**
 * Split text into lines the way a line-numbering tool should.
 *
 * The same rule `readLineWindow` applies while streaming, for content already
 * in memory: a single trailing terminator ends the last line rather than
 * starting an empty one, so the count matches grep and `wc -l`, and any `\r`
 * stays on the line it terminates. Kept next to the streaming version rather
 * than beside its caller, because two implementations of one rule in two files
 * is how they come to disagree — see the test that holds them to each other.
 */
export function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  const normalized = content.endsWith('\n') ? content.slice(0, -1) : content;
  return normalized.split('\n');
}

/**
 * Read a window of lines out of a file, along with the file's total line count
 * and a hash of its bytes.
 *
 * Streams rather than slurping, so memory is bounded by the window (`maxBytes`)
 * and not by the file: a search or a read over a multi-gigabyte log costs the
 * same as one over a small source file. The whole file is still walked, because
 * `totalLines` and `hash` are statements about all of it — but nothing outside
 * the window is retained.
 *
 * Any `\r` stays attached to the line it terminates. `read_file`'s output is
 * what a model copies an `edit_file` `oldString` out of, and `edit_file` matches
 * against the file's actual bytes, so stripping CR here would make edits to a
 * CRLF file impossible to express.
 */
export async function readLineWindow(
  filePath: string,
  options: LineWindowOptions = {},
): Promise<LineWindow> {
  const start = options.startLine ?? 1;
  const last = options.endLine ?? Infinity;
  const maxBytes = options.maxBytes ?? Infinity;

  const digest = createHash('sha256');
  const decoder = new StringDecoder('utf8');
  const lines: string[] = [];
  let byteLength = 0;
  let totalLines = 0;
  let windowBytes = 0;
  let end = start - 1;
  let truncated = false;
  let lineClipped = false;

  // Held only while the current line is one the window wants; otherwise the
  // characters are counted and dropped, so a file with no newlines at all does
  // not end up buffered in full.
  let pendingText = '';
  let pendingLength = 0;

  const wanted = (): boolean => !truncated && totalLines + 1 >= start && totalLines + 1 <= last;

  const take = (line: string, keep: boolean): void => {
    totalLines++;
    if (!keep) return;
    const cost = Buffer.byteLength(line, 'utf8') + 1;
    if (lines.length === 0) {
      // The window's first line always goes in — a window that renders
      // nothing tells the model nothing — but "goes in" cannot mean
      // "however long it is": a minified bundle or a one-line JSON dump is
      // one line the size of the whole file, and including it whole is
      // exactly the unbounded read `maxBytes` exists to prevent. Clip it
      // instead, the same way a byte-capped read would.
      const clipped = cost > maxBytes ? clipToBytes(line, maxBytes) : line;
      if (clipped !== line) {
        truncated = true;
        lineClipped = true;
      }
      windowBytes = Buffer.byteLength(clipped, 'utf8') + 1;
      lines.push(clipped);
      end = totalLines;
      return;
    }
    if (windowBytes + cost > maxBytes) {
      truncated = true;
      return;
    }
    windowBytes += cost;
    lines.push(line);
    end = totalLines;
  };

  const consume = (text: string): void => {
    let pos = 0;
    while (pos < text.length) {
      const idx = text.indexOf('\n', pos);
      if (idx === -1) {
        const rest = text.slice(pos);
        pendingLength += rest.length;
        // Bounded rather than unconditional: an unterminated line past
        // `maxBytes` is going to be clipped by `take` regardless, so nothing
        // past the cap needs to sit in memory while streaming arrives.
        if (wanted() && pendingText.length <= maxBytes) pendingText += rest;
        return;
      }
      const keep = wanted();
      take(keep ? pendingText + text.slice(pos, idx) : '', keep);
      pendingText = '';
      pendingLength = 0;
      pos = idx + 1;
    }
  };

  for await (const chunk of createReadStream(filePath) as AsyncIterable<Buffer>) {
    digest.update(chunk);
    byteLength += chunk.length;
    consume(decoder.write(chunk));
  }
  consume(decoder.end());
  // A file that does not end in a terminator still has a final line.
  if (pendingLength > 0) take(pendingText, wanted());

  return {
    hash: digest.digest('hex').slice(0, 16),
    byteLength,
    totalLines,
    lines,
    end,
    truncated,
    lineClipped,
  };
}
