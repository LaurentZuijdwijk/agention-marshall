// ── a terminal, enough of one to catch a bad erase ────────────────────────────
//
// Every duplicated-row bug in this CLI is invisible to a test that asserts on
// the bytes Ink wrote, because the bytes are *fine*: the text appears once per
// frame, exactly as intended. What goes wrong is the erase in front of it. Ink
// rewinds the cursor by the number of `\n`-separated lines it last wrote, and a
// terminal counts physical rows — so a line that wrapped, or a frame written
// after the width changed, leaves its top rows behind. Concatenated output
// cannot show that. A screen can.
//
// So this replays what Ink writes through the parts of a terminal that decide
// where text lands: the cursor, auto-wrap, and the erase sequences. It is not an
// emulator — no scroll regions, no alternate screen, no character sets. It
// handles what Ink emits, and asserts on the result.

const ESC = '\u001B';

export interface ScreenOptions {
  columns: number;
  rows: number;
}

export class Screen {
  readonly columns: number;
  readonly rows: number;

  /** The whole buffer, scrollback first. The last `rows` entries are on screen. */
  private buffer: string[] = [''];
  private row = 0;
  private col = 0;
  /**
   * The cursor is parked in the last column with a character already there.
   * A terminal defers the wrap until the *next* printable character, and getting
   * this wrong is the difference between a full-width row costing one row and
   * costing two — which is the whole class of bug this file exists to catch.
   */
  private pendingWrap = false;

  constructor({ columns, rows }: ScreenOptions) {
    this.columns = columns;
    this.rows = rows;
  }

  /** Everything written so far, scrollback included, trailing blanks trimmed. */
  lines(): string[] {
    const out = this.buffer.map(line => line.replace(/\s+$/, ''));
    while (out.length > 0 && out[out.length - 1] === '') out.pop();
    return out;
  }

  /** What the user can actually see: the last `rows` lines. */
  visible(): string[] {
    return this.lines().slice(-this.rows);
  }

  text(): string {
    return this.lines().join('\n');
  }

  /** How many lines contain `needle`. The assertion most of these tests want. */
  count(needle: string): number {
    return this.lines().filter(line => line.includes(needle)).length;
  }

  write(chunk: string): void {
    let i = 0;
    while (i < chunk.length) {
      const ch = chunk[i];

      if (ch === ESC) {
        const consumed = this.escape(chunk, i);
        if (consumed > 0) { i += consumed; continue; }
        i++; // A sequence we don't model: drop the ESC and print the rest.
        continue;
      }

      if (ch === '\n') {
        // ONLCR: node leaves output post-processing on, so LF carries a CR.
        this.col = 0;
        this.pendingWrap = false;
        this.down();
        i++;
        continue;
      }

      if (ch === '\r') {
        this.col = 0;
        this.pendingWrap = false;
        i++;
        continue;
      }

      // Control characters we don't model print nothing rather than shifting
      // every column after them.
      if (ch < ' ') { i++; continue; }

      this.put(ch);
      i++;
    }
  }

  // ── the cursor ──────────────────────────────────────────────────────────────

  private put(ch: string): void {
    if (this.pendingWrap) {
      this.col = 0;
      this.down();
      this.pendingWrap = false;
    }
    const line = this.buffer[this.row].padEnd(this.col, ' ');
    this.buffer[this.row] = line.slice(0, this.col) + ch + line.slice(this.col + 1);
    if (this.col === this.columns - 1) this.pendingWrap = true;
    else this.col++;
  }

  private down(): void {
    this.row++;
    while (this.buffer.length <= this.row) this.buffer.push('');
  }

  private up(count: number): void {
    this.row = Math.max(0, this.row - count);
    this.pendingWrap = false;
  }

  /** Index in `buffer` of the top row of the visible screen. */
  private screenTop(): number {
    return Math.max(0, this.buffer.length - this.rows);
  }

  // ── escape sequences ────────────────────────────────────────────────────────

  /** Returns how many characters the sequence at `start` consumed, 0 if unknown. */
  private escape(chunk: string, start: number): number {
    if (chunk[start + 1] !== '[') return 0;

    // CSI: parameters, then a final byte in @..~.
    let i = start + 2;
    while (i < chunk.length && !/[@-~]/.test(chunk[i])) i++;
    if (i >= chunk.length) return 0;

    const params = chunk.slice(start + 2, i);
    const final = chunk[i];
    const consumed = i - start + 1;
    const n = (fallback = 1) => {
      const value = Number.parseInt(params, 10);
      return Number.isNaN(value) ? fallback : value;
    };

    switch (final) {
      case 'A': this.up(n()); break;
      case 'B': for (let k = 0; k < n(); k++) this.down(); this.pendingWrap = false; break;
      case 'C': this.col = Math.min(this.columns - 1, this.col + n()); this.pendingWrap = false; break;
      case 'D': this.col = Math.max(0, this.col - n()); this.pendingWrap = false; break;
      case 'E': this.col = 0; for (let k = 0; k < n(); k++) this.down(); this.pendingWrap = false; break;
      case 'F': this.col = 0; this.up(n()); break;
      case 'G': this.col = Math.min(this.columns - 1, Math.max(0, n() - 1)); this.pendingWrap = false; break;
      case 'H': case 'f': {
        const [r = '1', c = '1'] = params.split(';');
        this.row = this.screenTop() + Math.max(0, (Number.parseInt(r, 10) || 1) - 1);
        while (this.buffer.length <= this.row) this.buffer.push('');
        this.col = Math.max(0, (Number.parseInt(c, 10) || 1) - 1);
        this.pendingWrap = false;
        break;
      }
      case 'K': this.eraseInLine(n(0)); break;
      case 'J': this.eraseInDisplay(n(0)); break;
      // SGR, cursor visibility, synchronized update, kitty keyboard: none of
      // them move the cursor, which is all this model tracks.
      case 'm': case 'h': case 'l': case 'u': break;
      default: break;
    }
    return consumed;
  }

  private eraseInLine(mode: number): void {
    const line = this.buffer[this.row].padEnd(this.col, ' ');
    if (mode === 0) this.buffer[this.row] = line.slice(0, this.col);
    else if (mode === 1) this.buffer[this.row] = ' '.repeat(this.col) + line.slice(this.col);
    else this.buffer[this.row] = '';
    this.pendingWrap = false;
  }

  private eraseInDisplay(mode: number): void {
    const top = this.screenTop();
    if (mode === 2) {
      // Erase the screen. The cursor does not move, and scrollback survives.
      for (let r = top; r < this.buffer.length; r++) this.buffer[r] = '';
    } else if (mode === 3) {
      // Erase scrollback. Everything above the screen is gone for good — this is
      // the one that makes an oversized Ink frame unscrollable.
      this.buffer = this.buffer.slice(top);
      this.row = Math.max(0, this.row - top);
    } else if (mode === 0) {
      this.buffer[this.row] = this.buffer[this.row].slice(0, this.col);
      for (let r = this.row + 1; r < this.buffer.length; r++) this.buffer[r] = '';
    } else if (mode === 1) {
      for (let r = top; r < this.row; r++) this.buffer[r] = '';
      this.buffer[this.row] = ' '.repeat(this.col) + this.buffer[this.row].slice(this.col);
    }
    this.pendingWrap = false;
  }
}
