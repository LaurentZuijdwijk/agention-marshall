import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatToolInput, shortenPath, truncate } from './format.js';
import { mix, brand } from './theme.js';

describe('formatToolInput', () => {
  it('returns an empty string for empty or non-object input', () => {
    assert.equal(formatToolInput({}), '');
    assert.equal(formatToolInput(undefined), '');
    assert.equal(formatToolInput(null), '');
    assert.equal(formatToolInput('nope'), '');
  });

  it('shows the primary key verbatim', () => {
    assert.equal(formatToolInput({ path: 'src/App.tsx' }), 'src/App.tsx');
    assert.equal(formatToolInput({ command: 'npm test' }), 'npm test');
  });

  it('notes how many other keys were folded away', () => {
    assert.equal(formatToolInput({ path: 'a.ts', start: 1, end: 20 }), 'a.ts  +2');
  });

  it('collapses whitespace so a multi-line command stays on one row', () => {
    assert.equal(formatToolInput({ command: 'git diff\n  --stat' }), 'git diff --stat');
  });

  it('falls back to key=value pairs, summarising nested values', () => {
    assert.equal(
      formatToolInput({ recursive: true, items: [1, 2, 3], opts: { a: 1 } }),
      'recursive=true items=[3] opts={…}',
    );
  });

  it('truncates past the max width', () => {
    assert.equal(formatToolInput({ command: 'x'.repeat(200) }, 10), 'x'.repeat(9) + '…');
  });
});

describe('truncate', () => {
  it('leaves short text alone', () => {
    assert.equal(truncate('abc', 10), 'abc');
  });

  it('never exceeds the max width', () => {
    assert.equal(truncate('abcdefghij', 5).length, 5);
  });
});

describe('shortenPath', () => {
  it('collapses the home directory', () => {
    assert.equal(shortenPath('/home/me/code/app', '/home/me'), '~/code/app');
  });

  it('leaves paths outside home untouched', () => {
    assert.equal(shortenPath('/srv/app', '/home/me'), '/srv/app');
  });

  it('elides leading segments when too long, keeping the tail', () => {
    const out = shortenPath('/a/very/deeply/nested/project/path/here', undefined, 20);
    assert.ok(out.startsWith('…/'), out);
    assert.ok(out.endsWith('here'), out);
    assert.ok(out.length <= 22, out);
  });
});

describe('theme colours', () => {
  it('mixes hex endpoints', () => {
    assert.equal(mix('#000000', '#ffffff', 0), '#000000');
    assert.equal(mix('#000000', '#ffffff', 1), '#ffffff');
    assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
  });

  it('clamps out-of-range positions', () => {
    assert.equal(mix('#000000', '#ffffff', -3), '#000000');
    assert.equal(mix('#000000', '#ffffff', 9), '#ffffff');
  });

  it('always produces a well-formed hex colour along the brand ramp', () => {
    for (let i = 0; i <= 10; i++) {
      assert.match(brand(i / 10), /^#[0-9a-f]{6}$/);
    }
  });
});
