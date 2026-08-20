import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { readLineWindow, splitLines } from './line-window.js';

function fileWith(content: string | Buffer): string {
  const path = join(mkdtempSync(join(tmpdir(), 'marshall-window-')), 'f');
  writeFileSync(path, content);
  return path;
}

const sha16 = (content: string | Buffer): string =>
  createHash('sha256').update(content).digest('hex').slice(0, 16);

test('a trailing terminator ends the last line rather than starting an empty one', async () => {
  const cases: Array<[string, number]> = [
    ['', 0],
    ['\n', 1],
    ['one', 1],
    ['one\n', 1],
    ['one\ntwo', 2],
    ['one\ntwo\n', 2],
    ['one\n\n', 2],
  ];
  for (const [content, expected] of cases) {
    const { totalLines } = await readLineWindow(fileWith(content));
    assert.equal(totalLines, expected, `${JSON.stringify(content)} is ${expected} line(s)`);
  }
});

test('CR stays on the line it terminates', async () => {
  const { lines, totalLines } = await readLineWindow(fileWith('alpha\r\nbeta\r\n'));
  assert.equal(totalLines, 2);
  assert.deepEqual(lines, ['alpha\r', 'beta\r']);
});

test('the window is the requested range, and end reports what was collected', async () => {
  const path = fileWith(Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');

  const middle = await readLineWindow(path, { startLine: 4, endLine: 6 });
  assert.deepEqual(middle.lines, ['line 4', 'line 5', 'line 6']);
  assert.equal(middle.end, 6);
  assert.equal(middle.totalLines, 10, 'the total covers the whole file, not the window');
  assert.equal(middle.truncated, false);

  const past = await readLineWindow(path, { startLine: 99 });
  assert.deepEqual(past.lines, []);
  assert.equal(past.end, 98, 'end is startLine - 1 when nothing was collected');
  assert.equal(past.totalLines, 10);
});

test('maxBytes stops the window and says it did, but never renders nothing', async () => {
  const path = fileWith(Array.from({ length: 100 }, () => 'x'.repeat(9)).join('\n') + '\n');

  const capped = await readLineWindow(path, { maxBytes: 35 });
  assert.equal(capped.lines.length, 3, '3 lines of 10 bytes fit in 35');
  assert.equal(capped.end, 3);
  assert.equal(capped.truncated, true);
  assert.equal(capped.lineClipped, false, 'the window stopped between lines, not mid-line');
  assert.equal(capped.totalLines, 100, 'the total is still the whole file');

  // A budget smaller than the first line still has to show something — a
  // window that renders nothing tells the caller nothing — but "something"
  // now means a clipped prefix, not the whole 9-byte line ignoring the cap.
  const tiny = await readLineWindow(path, { maxBytes: 1 });
  assert.equal(tiny.lines.length, 1);
  assert.ok(Buffer.byteLength(tiny.lines[0], 'utf8') <= 1, `line was not clipped to the budget: ${JSON.stringify(tiny.lines[0])}`);
  assert.equal(tiny.truncated, true);
  assert.equal(tiny.lineClipped, true);
});

// The real defect this guards: a file whose first line is itself the whole
// file — a minified bundle, a one-line JSON dump — used to bypass `maxBytes`
// entirely, because "the first line always goes in" had no upper bound of its
// own. That sent a full 480 KB single-line file into a provider's context
// window uncapped and got it rejected; `maxFileBytes` had no effect at all.
test('a single line larger than the whole file cap is clipped, not sent through whole', async () => {
  const huge = 'x'.repeat(500_000); // no newline anywhere — one line, 500 KB
  const path = fileWith(huge);

  const result = await readLineWindow(path, { maxBytes: 4096 });

  assert.equal(result.lines.length, 1);
  assert.ok(Buffer.byteLength(result.lines[0], 'utf8') <= 4096,
    `the single line must respect maxBytes: got ${Buffer.byteLength(result.lines[0], 'utf8')} bytes`);
  assert.equal(result.truncated, true);
  assert.equal(result.lineClipped, true, 'distinct from a window that stopped between lines');
  assert.equal(result.totalLines, 1);
  assert.equal(result.byteLength, 500_000, 'the file-wide stats still describe the whole file');
});

// The same file, but the oversized line sits deeper in — via `startLine`
// rather than being the first line on disk. The vulnerable branch is "the
// first line *this window* collects", not "the first line of the file", so a
// ranged read landing on a giant line must be clipped the same way.
test('a startLine that lands on an oversized line clips it the same way', async () => {
  const path = fileWith(`short one\nshort two\n${'y'.repeat(500_000)}\nshort four\n`);

  const result = await readLineWindow(path, { startLine: 3, endLine: 3, maxBytes: 4096 });

  assert.equal(result.lines.length, 1);
  assert.ok(Buffer.byteLength(result.lines[0], 'utf8') <= 4096);
  assert.equal(result.lineClipped, true);
  assert.equal(result.totalLines, 4);
});

// The inverse: an ordinary file whose lines all fit comfortably must not be
// clipped or flagged just because it has more than one line.
test('an ordinary file with no oversized line is never clipped', async () => {
  const path = fileWith('one\ntwo\nthree\n');
  const result = await readLineWindow(path, { maxBytes: 4096 });
  assert.deepEqual(result.lines, ['one', 'two', 'three']);
  assert.equal(result.truncated, false);
  assert.equal(result.lineClipped, false);
});

test('a multi-byte character split across the read boundary survives intact', async () => {
  // The chunk boundary lands mid-character: 'é' is two bytes, so an odd-byte
  // prefix guarantees one of them starts the next chunk.
  const filler = 'é'.repeat(40_000); // 80 KB, past the 64 KiB stream chunk
  const path = fileWith(`x${filler}\nsecond\n`);
  const { lines, totalLines } = await readLineWindow(path);
  assert.equal(totalLines, 2);
  assert.equal(lines[0], `x${filler}`, 'no replacement characters at the seam');
  assert.equal(lines[1], 'second');
});

test('a line spanning many chunks is assembled whole', async () => {
  const long = 'abcdefghij'.repeat(30_000); // 300 KB on one line
  const path = fileWith(`${long}\ntail\n`);
  const { lines, totalLines } = await readLineWindow(path, { maxBytes: 1024 * 1024 });
  assert.equal(totalLines, 2);
  assert.equal(lines[0], long);
});

test('the hash and byte length describe the whole file, not the window', async () => {
  const content = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n') + '\n';
  const path = fileWith(content);
  const { hash, byteLength } = await readLineWindow(path, { startLine: 2, endLine: 3, maxBytes: 16 });
  assert.equal(byteLength, Buffer.byteLength(content));
  assert.equal(hash, sha16(content), 'a windowed read still hashes every byte');
});

test('bytes that are not valid UTF-8 do not change the hash', async () => {
  const raw = Buffer.from([0x61, 0x0a, 0xff, 0xfe, 0x0a]);
  const path = fileWith(raw);
  const { hash, byteLength, totalLines } = await readLineWindow(path);
  assert.equal(byteLength, 5);
  assert.equal(totalLines, 2);
  assert.equal(hash, sha16(raw), 'hashing the bytes, not their lossy decoding');
});

// The reason `splitLines` lives beside `readLineWindow` rather than beside its
// caller: they implement one rule twice, once streaming and once in memory, and
// nothing but this test stops them drifting apart.
test('splitLines and readLineWindow agree on what a line is', async () => {
  const cases = [
    '', '\n', 'one', 'one\n', 'one\ntwo', 'one\ntwo\n', 'one\n\n', '\n\n',
    'crlf\r\nlines\r\n', 'crlf\r\nbare\r', 'mixed\r\nand\nplain\n', 'trailing spaces  \n',
  ];
  for (const content of cases) {
    const streamed = await readLineWindow(fileWith(content));
    const inMemory = splitLines(content);
    assert.deepEqual(inMemory, streamed.lines, `lines differ for ${JSON.stringify(content)}`);
    assert.equal(inMemory.length, streamed.totalLines, `count differs for ${JSON.stringify(content)}`);
  }
});

test('a missing file rejects rather than reporting an empty one', async () => {
  await assert.rejects(readLineWindow(join(tmpdir(), 'marshall-window-absent', 'nope')), /ENOENT/);
});
