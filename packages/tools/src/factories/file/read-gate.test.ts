// ── the read gate ─────────────────────────────────────────────────────────────
//
// `read_file`, `write_file` and `edit_file` tested together because they are one
// mechanism: what a read recorded is the only thing a write is allowed to act
// on. Splitting these apart would leave each half asserting on state the other
// half owns.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileTools, createReadOnlyFileTools } from './index.js';
import { createKeyedLock } from '../../primitives/keyed-lock.js';
import type { ToolConfig, ApprovalRequest } from '../../types.js';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'marshall-file-test-'));
}

function makeConfig(overrides: Partial<ToolConfig> = {}): ToolConfig {
  return {
    workspaceRoot: tempRoot(),
    approval: async () => 'approve',
    ...overrides,
  };
}

test('read_file returns content with a header and numbered lines', async () => {
  const root = tempRoot();
  const file = join(root, 'a.txt');
  writeFileSync(file, 'line one\nline two\nline three\n');
  const [read_file] = createReadOnlyFileTools(root);
  const result = await read_file.execute('a', 'b', { path: 'a.txt' }, 'id');
  assert.match(result, /a\.txt/);
  assert.match(result, /\(lines 1–3 of 3\)/);
  assert.match(result, /1 \| line one/);
  assert.match(result, /3 \| line three/);
});

test('read_file honours startLine/endLine and reports sample range and total lines', async () => {
  const root = tempRoot();
  const file = join(root, 'a.txt');
  writeFileSync(file, 'one\ntwo\nthree\n');
  const [read_file] = createReadOnlyFileTools(root);
  const result = await read_file.execute('a', 'b', { path: 'a.txt', startLine: 2, endLine: 2 }, 'id');
  assert.match(result, /\(lines 2–2 of 3\)/);
  assert.match(result, /2 \| two/);
  assert.doesNotMatch(result, /one/);
  assert.doesNotMatch(result, /three/);
});

test('read_file reports total lines and sample lines when file exceeds maxFileBytes', async () => {
  const root = tempRoot();
  const file = join(root, 'long.txt');
  // Create 1000 lines of 10 bytes each (~10KB)
  const lines = Array.from({ length: 1000 }, (_, i) => `line ${String(i + 1).padStart(4, '0')}`);
  writeFileSync(file, lines.join('\n') + '\n');
  // Cap at 200 bytes
  const [read_file] = createReadOnlyFileTools(root, { maxFileBytes: 200 });
  const result = await read_file.execute('a', 'b', { path: 'long.txt' }, 'id');
  assert.match(result, /long\.txt/);
  assert.match(result, /of 1000\)/);
  assert.match(result, /\[\.\.\.file truncated — showing lines 1–\d+ of 1000/);
});

test('read_file partial read past byte limit returns correct lines and line numbers', async () => {
  const root = tempRoot();
  const file = join(root, 'long.txt');
  const lines = Array.from({ length: 1000 }, (_, i) => `line ${String(i + 1).padStart(4, '0')}`);
  writeFileSync(file, lines.join('\n') + '\n');
  // Small maxFileBytes
  const [read_file] = createReadOnlyFileTools(root, { maxFileBytes: 200 });
  const result = await read_file.execute('a', 'b', { path: 'long.txt', startLine: 500, endLine: 505 }, 'id');
  assert.match(result, /\(lines 500–505 of 1000\)/);
  assert.match(result, /500 \| line 0500/);
  assert.match(result, /505 \| line 0505/);
});

test('read_file counts lines the way grep does, not one more', async () => {
  const root = tempRoot();
  const [read_file] = createReadOnlyFileTools(root);

  writeFileSync(join(root, 'terminated.txt'), 'one\ntwo\n');
  writeFileSync(join(root, 'bare.txt'), 'one\ntwo');
  writeFileSync(join(root, 'empty.txt'), '');

  assert.match(await read_file.execute('a', 'b', { path: 'terminated.txt' }, 'id'), /\(lines 1–2 of 2\)/);
  assert.match(await read_file.execute('a', 'b', { path: 'bare.txt' }, 'id'), /\(lines 1–2 of 2\)/);

  const empty = await read_file.execute('a', 'b', { path: 'empty.txt' }, 'id');
  assert.match(empty, /\(lines 0–0 of 0\)/);
  assert.match(empty, /\(empty file\)/);
});

// read_file's render is what a model copies an oldString out of, and edit_file
// matches the file's actual bytes. Dropping the CR would make every multi-line
// edit to a CRLF file unexpressible: the string the model was shown is not a
// string the file contains.
test('read_file preserves CRLF line endings, so an edit built from its output still matches', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'crlf.txt'), 'alpha\r\nbeta\r\ngamma\r\n');
  const tools = createFileTools(makeConfig({ workspaceRoot: root }));
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

  const rendered = await byName.read_file.execute('a', 'b', { path: 'crlf.txt' }, 'id');
  assert.match(rendered, /\(lines 1–3 of 3\)/);
  assert.match(rendered, /1 \| alpha\r/, 'the CR is still there');

  // Exactly what the render shows for lines 1–2, stripped of the gutter.
  const result = await byName.edit_file.execute(
    'a', 'b', { path: 'crlf.txt', oldString: 'alpha\r\nbeta', newString: 'ALPHA\r\nBETA' }, 'id',
  );
  assert.match(result, /Edited/);
  assert.equal(readFileSync(join(root, 'crlf.txt'), 'utf8'), 'ALPHA\r\nBETA\r\ngamma\r\n');
});

test('read_file rejects a reversed or unparseable line range instead of rendering NaN', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'a.txt'), 'one\ntwo\nthree\n');
  const [read_file] = createReadOnlyFileTools(root);

  const reversed = await read_file.execute('a', 'b', { path: 'a.txt', startLine: 3, endLine: 2 }, 'id');
  assert.match(reversed, /^Error: startLine 3 is after endLine 2/);

  const nonsense = await read_file.execute('a', 'b', { path: 'a.txt', startLine: 'abc' }, 'id');
  assert.match(nonsense, /^Error: startLine and endLine must be numbers/);
  assert.doesNotMatch(nonsense, /NaN/);
});

test('read_file says so when startLine is past the end of the file', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'a.txt'), 'one\ntwo\n');
  const [read_file] = createReadOnlyFileTools(root);
  const result = await read_file.execute('a', 'b', { path: 'a.txt', startLine: 99 }, 'id');
  assert.match(result, /beyond total lines 2/);
});

// What `maxFileBytes` has to bound is what gets *held*, not just what gets
// printed: reading a file whole and then slicing a window out of it looks
// identical from the outside. Comparing `heapUsed` cannot tell the two apart —
// V8 collects the intermediate string mid-operation and the delta comes back
// small either way — so this uses the one wall that is not a heuristic. A
// string cannot exceed ~512 MB, so a file past that is one no slurping
// implementation can read at all, however much memory it is given.
//
// The file is sparse: 600 MB apparent, ~2 MB on disk, well under a second.
const sparseSkip = process.platform === 'win32'
  ? 'NTFS zero-fills instead of making the file sparse'
  : false;

test('a file too large to hold as a string is still readable and searchable', { skip: sparseSkip }, async () => {
  const root = tempRoot();
  const MB = 1024 * 1024;
  const totalMB = 600;
  const fd = openSync(join(root, 'huge.bin'), 'w');
  try {
    // Real text across everything `search` will read (its per-file cap is
    // 256 KiB). The holes past that are NUL, which is what makes a file binary
    // — leave them inside the searched window and the file is correctly skipped
    // as binary, which is a different property than the one under test here.
    const prefix = Buffer.from('needle' + 'x'.repeat(512 * 1024));
    writeSync(fd, prefix, 0, prefix.length, 0);
    // One terminator per megabyte, and nothing in between — the holes cost no
    // blocks. The last one lands on the final byte, so the file ends cleanly.
    for (let k = 1; k <= totalMB; k++) writeSync(fd, Buffer.from('\n'), 0, 1, k * MB - 1);
  } finally {
    closeSync(fd);
  }

  const [read_file, , search] = createReadOnlyFileTools(root, { maxFileBytes: 4096 });

  const read = await read_file.execute('a', 'b', { path: 'huge.bin', startLine: 500, endLine: 500 }, 'id');
  assert.doesNotMatch(read, /^Error:/, 'a 600 MB file must not be unreadable');
  assert.match(read, /\(lines 500–500 of 600\)/, 'the total and the deep range are both exact');

  // Uncapped, search throws ERR_STRING_TOO_LONG here — and its `catch` swallows
  // that, so the file is skipped and the needle in its first bytes goes missing
  // with nothing said. Capped, the match is simply found.
  const found = await search.execute('a', 'b', { pattern: 'needle' }, 'id');
  assert.match(found, /^huge\.bin:1: needle/m);
});

test('read_file blocks path escape', async () => {
  const root = tempRoot();
  const [read_file] = createReadOnlyFileTools(root);
  const result = await read_file.execute('a', 'b', { path: '../../etc/passwd' }, 'id');
  assert.match(result, /^Error:/);
});

test('write_file creates a new file (no read required)', async () => {
  const root = tempRoot();
  const tools = createFileTools(makeConfig({ workspaceRoot: root }));
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const result = await byName.write_file.execute('a', 'b', { path: 'new.txt', content: 'hello' }, 'id');
  assert.match(result, /Wrote 5 bytes/);
  assert.equal(readFileSync(join(root, 'new.txt'), 'utf8'), 'hello');
});

test('write_file refuses to overwrite a file not read this session', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'existing.txt'), 'original');
  const tools = createFileTools(makeConfig({ workspaceRoot: root }));
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const result = await byName.write_file.execute('a', 'b', { path: 'existing.txt', content: 'new' }, 'id');
  assert.match(result, /has not been read this session/);
  assert.equal(readFileSync(join(root, 'existing.txt'), 'utf8'), 'original');
});

test('write_file allows overwrite after reading the file', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'existing.txt'), 'original');
  const tools = createFileTools(makeConfig({ workspaceRoot: root }));
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  await byName.read_file.execute('a', 'b', { path: 'existing.txt' }, 'id');
  const result = await byName.write_file.execute('a', 'b', { path: 'existing.txt', content: 'updated' }, 'id');
  assert.match(result, /Wrote/);
  assert.equal(readFileSync(join(root, 'existing.txt'), 'utf8'), 'updated');
});

// Seeing part of a file cannot authorize replacing all of it — content composed
// from the part discards the rest. The two ways of having seen only part need
// different advice, and telling a model to raise a limit it is not up against
// is advice it cannot act on.
test('write_file refuses after a ranged read, and names the range as the reason', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'small.txt'), 'one\ntwo\nthree\n');
  const tools = createFileTools(makeConfig({ workspaceRoot: root }));
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

  // A range that happens to cover the whole file is still a ranged read.
  await byName.read_file.execute('a', 'b', { path: 'small.txt', endLine: 999 }, 'id');
  const result = await byName.write_file.execute('a', 'b', { path: 'small.txt', content: 'x' }, 'id');

  assert.match(result, /read with startLine\/endLine/);
  assert.doesNotMatch(result, /maxFileBytes/,
    'the file is 14 bytes — raising the read limit would change nothing');
  assert.match(result, /edit_file/, 'and it must name the tool that would have worked');
  assert.equal(readFileSync(join(root, 'small.txt'), 'utf8'), 'one\ntwo\nthree\n');

  // Re-reading without a range is the stated fix, so it has to work.
  await byName.read_file.execute('a', 'b', { path: 'small.txt' }, 'id');
  assert.match(await byName.write_file.execute('a', 'b', { path: 'small.txt', content: 'x' }, 'id'), /Wrote/);
});

// The way around the gate above, if an edit counted as having read the file:
// read ten lines, make one targeted edit, and the file is suddenly "seen". It
// is not — edit_file matched a unique substring and rendered nothing else.
test('an edit_file does not promote a ranged read into a licence to overwrite', async () => {
  const root = tempRoot();
  // Zero-padded so no line number is a prefix of another — edit_file needs an
  // oldString that appears exactly once, and that is not what this is testing.
  const original = Array.from({ length: 40 }, (_, i) => `line ${String(i).padStart(2, '0')}`).join('\n') + '\n';
  writeFileSync(join(root, 'big.txt'), original);
  const tools = createFileTools(makeConfig({ workspaceRoot: root }));
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

  await byName.read_file.execute('a', 'b', { path: 'big.txt', startLine: 1, endLine: 3 }, 'id');
  assert.match(
    await byName.edit_file.execute('a', 'b', { path: 'big.txt', oldString: 'line 01', newString: 'LINE 01' }, 'id'),
    /Edited/,
    'the edit itself is fine — it is targeted, and only needs the file to have been read',
  );

  const result = await byName.write_file.execute('a', 'b', { path: 'big.txt', content: 'replaced\n' }, 'id');
  assert.match(result, /read with startLine\/endLine/, 'still a ranged read after the edit');
  assert.notEqual(readFileSync(join(root, 'big.txt'), 'utf8'), 'replaced\n');
  assert.match(readFileSync(join(root, 'big.txt'), 'utf8'), /line 39/, 'the unseen tail is intact');
});

// The other direction: the fix must not cost a caller that really did read the
// whole file the right to rewrite it after making an edit.
test('an edit_file after a full read leaves write_file allowed', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'small.txt'), 'alpha\nbeta\ngamma\n');
  const tools = createFileTools(makeConfig({ workspaceRoot: root }));
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

  await byName.read_file.execute('a', 'b', { path: 'small.txt' }, 'id');
  await byName.edit_file.execute('a', 'b', { path: 'small.txt', oldString: 'beta', newString: 'BETA' }, 'id');

  assert.match(
    await byName.write_file.execute('a', 'b', { path: 'small.txt', content: 'replaced\n' }, 'id'),
    /Wrote/,
  );
  assert.equal(readFileSync(join(root, 'small.txt'), 'utf8'), 'replaced\n');
});

test('write_file refuses after a read cut short by the byte limit, and says so', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'long.txt'), Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n') + '\n');
  const tools = createFileTools(makeConfig({ workspaceRoot: root, limits: { maxFileBytes: 200 } }));
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

  await byName.read_file.execute('a', 'b', { path: 'long.txt' }, 'id');
  const result = await byName.write_file.execute('a', 'b', { path: 'long.txt', content: 'x' }, 'id');

  assert.match(result, /exceeds the read limit/);
  assert.match(result, /maxFileBytes/);
});

// The permission dodge this guards: rather than edit_file, whose approval
// renders a diff, rewrite the whole file with write_file. The panel used to
// show the first 800 characters of the new content, so a change past that point
// was never displayed — the reviewer saw an unchanged, benign prefix and
// approved a change they were never shown.
test('write_file approval shows the change, not a prefix of the payload', async () => {
  const root = tempRoot();
  const lines = Array.from({ length: 400 }, (_, i) => `line ${i}: ordinary source content goes here`);
  const original = lines.join('\n');
  lines[300] = 'const ADMIN = true; // slipped in';
  const rewritten = lines.join('\n');
  writeFileSync(join(root, 'config.ts'), original);

  assert.equal(original.slice(0, 800), rewritten.slice(0, 800),
    'precondition: the first 800 characters are identical, which is the exploit');

  const seen: ApprovalRequest[] = [];
  const tools = createFileTools({
    workspaceRoot: root,
    approval: async (req) => { seen.push(req); return 'approve'; },
  });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  await byName.read_file.execute('a', 'b', { path: 'config.ts' }, 'id');
  await byName.write_file.execute('a', 'b', { path: 'config.ts', content: rewritten }, 'id');

  const [request] = seen;
  assert.match(request.detail, /slipped in/, 'the buried change must be in what the reviewer sees');
  assert.match(request.detail, /- line 300/, 'and what it replaced');
  assert.match(request.description, /\+1 −1/, 'the shape of the write is stated up front');
});

test('creating a new file still shows its content, having nothing to diff', async () => {
  const root = tempRoot();
  const seen: ApprovalRequest[] = [];
  const tools = createFileTools({
    workspaceRoot: root,
    approval: async (req) => { seen.push(req); return 'approve'; },
  });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  await byName.write_file.execute('a', 'b', { path: 'fresh.txt', content: 'hello\nthere' }, 'id');

  assert.match(seen[0].description, /Create file/);
  assert.match(seen[0].detail, /hello/);
});

test('edit_file requires a prior read', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'target.txt'), 'hello world');
  const tools = createFileTools(makeConfig({ workspaceRoot: root }));
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const result = await byName.edit_file.execute('a', 'b', { path: 'target.txt', oldString: 'world', newString: 'there' }, 'id');
  assert.match(result, /has not been read this session/);
  assert.match(result, /current contents before editing/);
});

test('edit_file explains missing and ambiguous matches', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'target.txt'), 'hello world\\nworld');
  const tools = createFileTools(makeConfig({ workspaceRoot: root }));
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  await byName.read_file.execute('a', 'b', { path: 'target.txt' }, 'id');

  const missing = await byName.edit_file.execute('a', 'b', { path: 'target.txt', oldString: 'missing', newString: 'there' }, 'id');
  assert.match(missing, /must match the file exactly, including whitespace/);

  const ambiguous = await byName.edit_file.execute('a', 'b', { path: 'target.txt', oldString: 'world', newString: 'there' }, 'id');
  assert.match(ambiguous, /Include more surrounding text to make it unique/);
});

// The belt is rebuilt every turn, so a factory-owned read set makes "read it
// first" silently mean "read it first *this turn*": read a file, let the turn
// end, and editing it in the next one fails with "has not been read this
// session" even though it was. `ToolConfig.readFiles` is what the session
// passes to make the tracking outlive one belt.
test('read tracking passed in survives a rebuilt belt, so a read carries into the next turn', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'target.txt'), 'hello world');
  const readFiles = new Map<string, string>();

  const turnOne = Object.fromEntries(
    createFileTools(makeConfig({ workspaceRoot: root, readFiles })).map((t) => [t.name, t]),
  );
  await turnOne.read_file.execute('a', 'b', { path: 'target.txt' }, 'id');

  const turnTwo = Object.fromEntries(
    createFileTools(makeConfig({ workspaceRoot: root, readFiles })).map((t) => [t.name, t]),
  );
  const result = await turnTwo.edit_file.execute('a', 'b', { path: 'target.txt', oldString: 'world', newString: 'there' }, 'id');

  assert.match(result, /Edited/);
  assert.equal(readFileSync(join(root, 'target.txt'), 'utf8'), 'hello there');
});

test('without a shared set each belt tracks its own reads', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'target.txt'), 'hello world');

  const turnOne = Object.fromEntries(
    createFileTools(makeConfig({ workspaceRoot: root })).map((t) => [t.name, t]),
  );
  await turnOne.read_file.execute('a', 'b', { path: 'target.txt' }, 'id');

  const turnTwo = Object.fromEntries(
    createFileTools(makeConfig({ workspaceRoot: root })).map((t) => [t.name, t]),
  );
  const result = await turnTwo.edit_file.execute('a', 'b', { path: 'target.txt', oldString: 'world', newString: 'there' }, 'id');
  assert.match(result, /has not been read this session/);
});

// Models routinely emit several edit_file calls in one assistant message, and
// the SDK runs them concurrently. edit_file is a read-modify-write, so without
// serialisation both calls read the same original and the second write drops
// the first edit — while both still report "Edited".
test('parallel edits to one file all land', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'target.txt'), 'AAA\nBBB\nCCC\n');
  const tools = createFileTools(makeConfig({ workspaceRoot: root }));
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  await byName.read_file.execute('a', 'b', { path: 'target.txt' }, 'id');

  const results = await Promise.all([
    byName.edit_file.execute('a', 'b', { path: 'target.txt', oldString: 'AAA', newString: 'XXX' }, 'i1'),
    byName.edit_file.execute('a', 'b', { path: 'target.txt', oldString: 'BBB', newString: 'YYY' }, 'i2'),
    byName.edit_file.execute('a', 'b', { path: 'target.txt', oldString: 'CCC', newString: 'ZZZ' }, 'i3'),
  ]);

  for (const r of results) assert.match(r, /Edited/, `every edit reported success: ${results.join(' | ')}`);
  assert.equal(readFileSync(join(root, 'target.txt'), 'utf8'), 'XXX\nYYY\nZZZ\n');
});

// Serialising these is not enough on its own: each carries whole-file content
// built from the same read, so the second legitimately overwrites the first and
// the first's changes are simply gone — with both reporting success. The second
// has to be refused and told what to do instead.
test('two write_file calls for one path in a batch: the second is rejected, not silently applied', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'plan.md'), '# Plan\n');
  const tools = createFileTools(makeConfig({ workspaceRoot: root }));
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  await byName.read_file.execute('a', 'b', { path: 'plan.md' }, 'id');

  const [first, second] = await Promise.all([
    byName.write_file.execute('a', 'b', { path: 'plan.md', content: '# Plan\n\n- one\n' }, 'i1'),
    byName.write_file.execute('a', 'b', { path: 'plan.md', content: '# Plan\n\n- two\n' }, 'i2'),
  ]);

  assert.match(first, /Wrote/);
  assert.match(second, /changed after you read it/,
    `the second write must be refused, got: ${second}`);
  // And it must point the model at the tool that would have worked.
  assert.match(second, /edit_file/);
  assert.equal(readFileSync(join(root, 'plan.md'), 'utf8'), '# Plan\n\n- one\n',
    'the first write survives intact');
});

test('a rejected write leaves the file readable and re-writable after a fresh read', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'plan.md'), '# Plan\n');
  const tools = createFileTools(makeConfig({ workspaceRoot: root }));
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  await byName.read_file.execute('a', 'b', { path: 'plan.md' }, 'id');

  await Promise.all([
    byName.write_file.execute('a', 'b', { path: 'plan.md', content: 'one\n' }, 'i1'),
    byName.write_file.execute('a', 'b', { path: 'plan.md', content: 'two\n' }, 'i2'),
  ]);

  // Recovery is the whole point of rejecting rather than failing hard: re-read,
  // then the write goes through.
  await byName.read_file.execute('a', 'b', { path: 'plan.md' }, 'id');
  const retry = await byName.write_file.execute('a', 'b', { path: 'plan.md', content: 'reconciled\n' }, 'i3');
  assert.match(retry, /Wrote/);
  assert.equal(readFileSync(join(root, 'plan.md'), 'utf8'), 'reconciled\n');
});

test('an external change between read and write is refused too', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'notes.txt'), 'from the model\n');
  const tools = createFileTools(makeConfig({ workspaceRoot: root }));
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  await byName.read_file.execute('a', 'b', { path: 'notes.txt' }, 'id');

  // Someone edits the file in their editor while the turn is in flight.
  writeFileSync(join(root, 'notes.txt'), 'hand-edited by the user\n');

  const result = await byName.write_file.execute('a', 'b', { path: 'notes.txt', content: 'model version\n' }, 'i1');
  assert.match(result, /changed after you read it/);
  assert.equal(readFileSync(join(root, 'notes.txt'), 'utf8'), 'hand-edited by the user\n',
    "a user's own edit must not be clobbered by a write composed before it");
});

test('parallel write_file and edit_file on one file do not interleave', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'target.txt'), 'original\n');
  const tools = createFileTools(makeConfig({ workspaceRoot: root }));
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  await byName.read_file.execute('a', 'b', { path: 'target.txt' }, 'id');

  // The lock is taken in call order, so the write lands first and the edit then
  // reads *its* output rather than a stale original.
  const [wrote, edited] = await Promise.all([
    byName.write_file.execute('a', 'b', { path: 'target.txt', content: 'replaced\n' }, 'i1'),
    byName.edit_file.execute('a', 'b', { path: 'target.txt', oldString: 'original', newString: 'edited' }, 'i2'),
  ]);

  assert.match(wrote, /Wrote/);
  assert.match(edited, /not found/,
    'the edit ran after the overwrite, so "original" is gone — a stale read would have found it');
  assert.equal(readFileSync(join(root, 'target.txt'), 'utf8'), 'replaced\n');
});

test('an injected lock serialises two belts writing one file', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'shared.txt'), 'alpha\nbeta\n');
  // What two agents get: a belt each, sharing the session's read tracking and
  // its lock. Without the shared lock each belt queues only against itself, so
  // both edits read the same original and the second write drops the first.
  const readFiles = new Map<string, string>();
  const fileLock = createKeyedLock();
  const beltA = Object.fromEntries(
    createFileTools(makeConfig({ workspaceRoot: root, readFiles, fileLock })).map((t) => [t.name, t]),
  );
  const beltB = Object.fromEntries(
    createFileTools(makeConfig({ workspaceRoot: root, readFiles, fileLock })).map((t) => [t.name, t]),
  );
  await beltA.read_file.execute('a', 'b', { path: 'shared.txt' }, 'id');

  const results = await Promise.all([
    beltA.edit_file.execute('a', 'b', { path: 'shared.txt', oldString: 'alpha', newString: 'ALPHA' }, 'i1'),
    beltB.edit_file.execute('a', 'b', { path: 'shared.txt', oldString: 'beta', newString: 'BETA' }, 'i2'),
  ]);

  for (const result of results) assert.match(result, /Edited/);
  assert.equal(readFileSync(join(root, 'shared.txt'), 'utf8'), 'ALPHA\nBETA\n',
    'both edits must survive — a per-belt lock loses whichever wrote first');
});

test('edit_file replaces a unique occurrence', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'target.txt'), 'hello world\n');
  const tools = createFileTools(makeConfig({ workspaceRoot: root }));
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  await byName.read_file.execute('a', 'b', { path: 'target.txt' }, 'id');
  const result = await byName.edit_file.execute('a', 'b', { path: 'target.txt', oldString: 'world', newString: 'there' }, 'id');
  assert.match(result, /Edited/);
  assert.equal(readFileSync(join(root, 'target.txt'), 'utf8'), 'hello there\n');
});

test('edit_file rejects an oldString that is not found', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'target.txt'), 'hello\n');
  const tools = createFileTools(makeConfig({ workspaceRoot: root }));
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  await byName.read_file.execute('a', 'b', { path: 'target.txt' }, 'id');
  const result = await byName.edit_file.execute('a', 'b', { path: 'target.txt', oldString: 'nope', newString: 'x' }, 'id');
  assert.match(result, /oldString not found/);
});

test('edit_file rejects an ambiguous oldString that appears multiple times', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'target.txt'), 'dup\ndup\n');
  const tools = createFileTools(makeConfig({ workspaceRoot: root }));
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  await byName.read_file.execute('a', 'b', { path: 'target.txt' }, 'id');
  const result = await byName.edit_file.execute('a', 'b', { path: 'target.txt', oldString: 'dup', newString: 'x' }, 'id');
  assert.match(result, /appears 2 times/);
});

test('file tools go through the approval gate', async () => {
  const calls: string[] = [];
  const root = tempRoot();
  const tools = createFileTools({ workspaceRoot: root, approval: async (req) => { calls.push(req.toolName); return 'approve'; } });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  await byName.write_file.execute('a', 'b', { path: 'approved.txt', content: 'x' }, 'id');
  assert.ok(calls.includes('write_file'));
});

test('file tools are denied by approval', async () => {
  const root = tempRoot();
  const tools = createFileTools({ workspaceRoot: root, approval: async () => 'deny' });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const result = await byName.edit_file.execute('a', 'b', { path: 'x.txt', oldString: 'a', newString: 'b' }, 'id');
  assert.match(result, /denied/i);
});
