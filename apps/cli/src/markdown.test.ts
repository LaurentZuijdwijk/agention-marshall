import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseInline, parseBlocks } from './markdown.js';
import type { Block } from './markdown.js';

// ── inline ────────────────────────────────────────────────────────────────────

describe('parseInline', () => {
  it('returns plain text as a single span', () => {
    assert.deepEqual(parseInline('hello there'), [{ text: 'hello there' }]);
  });

  it('returns nothing for an empty string', () => {
    assert.deepEqual(parseInline(''), []);
  });

  it('marks code, bold, italic and strikethrough', () => {
    assert.deepEqual(parseInline('`x`'),     [{ text: 'x', code: true }]);
    assert.deepEqual(parseInline('**x**'),   [{ text: 'x', bold: true }]);
    assert.deepEqual(parseInline('*x*'),     [{ text: 'x', italic: true }]);
    assert.deepEqual(parseInline('~~x~~'),   [{ text: 'x', strike: true }]);
  });

  it('keeps the surrounding text', () => {
    assert.deepEqual(parseInline('run `npm test` now'), [
      { text: 'run ' },
      { text: 'npm test', code: true },
      { text: ' now' },
    ]);
  });

  it('prefers bold over italic so ** is not read as two *', () => {
    assert.deepEqual(parseInline('**x**'), [{ text: 'x', bold: true }]);
  });

  it('treats markup inside code as literal', () => {
    assert.deepEqual(parseInline('`a **b** c`'), [{ text: 'a **b** c', code: true }]);
  });

  it('leaves unclosed delimiters literal — the streaming case', () => {
    assert.deepEqual(parseInline('a **bold'), [{ text: 'a **bold' }]);
    assert.deepEqual(parseInline('half `code'), [{ text: 'half `code' }]);
  });

  it('does not mangle snake_case identifiers', () => {
    assert.deepEqual(parseInline('call read_file_now(x)'), [{ text: 'call read_file_now(x)' }]);
  });

  it('keeps a link label and shows the url as an aside', () => {
    assert.deepEqual(parseInline('[docs](https://x.dev)'), [
      { text: 'docs', link: true },
      { text: ' (https://x.dev)', dim: true },
    ]);
  });

  it('does not repeat the url when it is also the label', () => {
    assert.deepEqual(parseInline('[https://x.dev](https://x.dev)'), [
      { text: 'https://x.dev', link: true },
    ]);
  });

  it('is reusable across calls despite the shared global regex', () => {
    const once = parseInline('`a` and `b`');
    assert.deepEqual(parseInline('`a` and `b`'), once);
    assert.deepEqual(parseInline('`a` and `b`'), once);
  });
});

// ── blocks ────────────────────────────────────────────────────────────────────

const kinds = (blocks: Block[]) => blocks.map(b => b.kind);

describe('parseBlocks', () => {
  it('reads headings with their level', () => {
    const [h] = parseBlocks('### Setup');
    assert.equal(h.kind, 'heading');
    assert.equal(h.kind === 'heading' && h.level, 3);
    assert.deepEqual(h.kind === 'heading' && h.spans, [{ text: 'Setup' }]);
  });

  it('strips closing hashes from a heading', () => {
    const [h] = parseBlocks('## Title ##');
    assert.deepEqual(h.kind === 'heading' && h.spans, [{ text: 'Title' }]);
  });

  it('groups a fenced block and records its language', () => {
    const [c] = parseBlocks('```ts\nconst a = 1;\nconst b = 2;\n```');
    assert.equal(c.kind, 'code');
    assert.equal(c.kind === 'code' && c.lang, 'ts');
    assert.deepEqual(c.kind === 'code' && c.lines, ['const a = 1;', 'const b = 2;']);
  });

  it('does not parse markup inside a fence', () => {
    const [c] = parseBlocks('```\n**not bold**\n# not a heading\n```');
    assert.deepEqual(c.kind === 'code' && c.lines, ['**not bold**', '# not a heading']);
  });

  it('runs an unterminated fence to the end — the streaming case', () => {
    const blocks = parseBlocks('```js\nlet x =');
    assert.deepEqual(kinds(blocks), ['code']);
    assert.deepEqual(blocks[0].kind === 'code' && blocks[0].lines, ['let x =']);
  });

  it('reads bullets, normalising the marker', () => {
    const blocks = parseBlocks('- one\n* two\n+ three');
    assert.deepEqual(kinds(blocks), ['item', 'item', 'item']);
    assert.deepEqual(blocks.map(b => b.kind === 'item' && b.marker), ['•', '•', '•']);
  });

  it('keeps ordered-list numbers', () => {
    const [a, b] = parseBlocks('1. first\n2. second');
    assert.equal(a.kind === 'item' && a.marker, '1.');
    assert.equal(b.kind === 'item' && b.marker, '2.');
  });

  it('derives nesting depth from leading spaces', () => {
    const blocks = parseBlocks('- top\n  - nested\n    - deeper');
    assert.deepEqual(blocks.map(b => b.kind === 'item' && b.indent), [0, 1, 2]);
  });

  it('recognises horizontal rules but not a bulleted dash', () => {
    assert.deepEqual(kinds(parseBlocks('---')), ['rule']);
    assert.deepEqual(kinds(parseBlocks('***')), ['rule']);
    assert.deepEqual(kinds(parseBlocks('- item')), ['item']);
  });

  it('reads blockquotes', () => {
    const [q] = parseBlocks('> note this');
    assert.equal(q.kind, 'quote');
    assert.deepEqual(q.kind === 'quote' && q.spans, [{ text: 'note this' }]);
  });

  it('keeps one paragraph block per line so line breaks survive', () => {
    assert.deepEqual(kinds(parseBlocks('one\ntwo')), ['para', 'para']);
  });

  it('preserves blank lines as spacing', () => {
    assert.deepEqual(kinds(parseBlocks('a\n\nb')), ['para', 'blank', 'para']);
  });

  it('handles a mixed document', () => {
    const doc = [
      '# Title',
      '',
      'Some **bold** text.',
      '',
      '- a point',
      '',
      '```sh',
      'npm test',
      '```',
      '> caveat',
    ].join('\n');
    assert.deepEqual(kinds(parseBlocks(doc)), [
      'heading', 'blank', 'para', 'blank', 'item', 'blank', 'code', 'quote',
    ]);
  });

  it('never loses a line', () => {
    // Every non-fence line must produce exactly one block.
    const doc = 'a\n# b\n- c\n> d\n\ne';
    assert.equal(parseBlocks(doc).length, 6);
  });
});
