import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trailingAtToken, completeAtPath, expandFileMentions } from './fileCompletion.js';

let root = '';

/** A workspace that mirrors the shapes worth completing against. */
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'at-completion-'));
  mkdirSync(join(root, 'src/view'), { recursive: true });
  mkdirSync(join(root, 'src/hooks'), { recursive: true });
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'src/App.tsx'), '// app\n');
  writeFileSync(join(root, 'src/index.tsx'), '// index\n');
  writeFileSync(join(root, 'src/view/theme.ts'), '// theme\n');
  writeFileSync(join(root, 'src/hooks/useSession.ts'), '// session\n');
  writeFileSync(join(root, 'package.json'), '{}\n');
  writeFileSync(join(root, '.env'), 'SECRET=1\n');
  writeFileSync(join(root, 'docs/guide.md'), '# guide\n');
  writeFileSync(join(root, 'bin.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('trailingAtToken', () => {
  it('finds a bare @ at the start of the input', () => {
    assert.deepEqual(trailingAtToken('@src/Ap'), { token: 'src/Ap', start: 0 });
  });

  it('finds an @ after whitespace', () => {
    assert.deepEqual(trailingAtToken('review @src/Ap'), { token: 'src/Ap', start: 7 });
  });

  it('ignores @ inside a word — an email is not a file reference', () => {
    assert.equal(trailingAtToken('mail me@example.com'), null);
  });

  it('stops at whitespace after the token', () => {
    assert.equal(trailingAtToken('@src/App.tsx please'), null);
  });

  it('ignores text without an @', () => {
    assert.equal(trailingAtToken('nothing here'), null);
  });
});

describe('completeAtPath', () => {
  it('completes to the longest common prefix', () => {
    assert.equal(completeAtPath('@s', root), 'rc/');
    assert.equal(completeAtPath('@src/A', root), 'pp.tsx');
  });

  it('offers a unique directory one / at a time', () => {
    assert.equal(completeAtPath('@src/v', root), 'iew/');
  });

  it('opens an exact directory with /', () => {
    assert.equal(completeAtPath('@src/view', root), '/');
    assert.equal(completeAtPath('@src/hooks', root), '/');
  });

  it('stops once a file is complete', () => {
    assert.equal(completeAtPath('@src/App.tsx', root), '');
  });

  it('picks up after the directory walk', () => {
    assert.equal(completeAtPath('@src/view/t', root), 'heme.ts');
  });

  it('skips dotfiles and .git', () => {
    assert.equal(completeAtPath('@.', root), '');
    assert.equal(completeAtPath('@.g', root), '');
  });

  it('completes from a bare @', () => {
    const ghost = completeAtPath('@', root);
    assert.ok(ghost === '' || !ghost.includes('/'), `common prefix only, got ${ghost}`);
  });

  it('completes mid-sentence', () => {
    assert.equal(completeAtPath('check @src/A', root), 'pp.tsx');
  });

  it('refuses to walk out of the root', () => {
    assert.equal(completeAtPath('@../', root), '');
    assert.equal(completeAtPath('@src/../../', root), '');
  });

  it('returns nothing for a directory that does not exist', () => {
    assert.equal(completeAtPath('@nope/', root), '');
  });
});

describe('expandFileMentions', () => {
  it('inlines a file behind its mention', () => {
    const { text, mentions } = expandFileMentions('review @src/App.tsx please', root);
    assert.equal(text, 'review `src/App.tsx`:\n\n```\n// app\n``` please');
    assert.deepEqual(mentions.map(m => [m.token, m.outcome]), [['@src/App.tsx', 'ok']]);
  });

  it('inlines several files', () => {
    const { text, mentions } = expandFileMentions('@src/App.tsx vs @src/index.tsx', root);
    assert.equal(mentions.length, 2);
    assert.ok(text.includes('// app'));
    assert.ok(text.includes('// index'));
  });

  it('leaves missing files as typed and does not announce them', () => {
    const { text, mentions } = expandFileMentions('see @src/Gone.tsx', root);
    assert.equal(text, 'see @src/Gone.tsx');
    assert.deepEqual(mentions, []);
  });

  it('leaves directories as typed', () => {
    const { text, mentions } = expandFileMentions('see @src', root);
    assert.equal(text, 'see @src');
    assert.deepEqual(mentions, []);
  });

  it('announces a binary file without inlining it', () => {
    const { text, mentions } = expandFileMentions('look @bin.png', root);
    assert.equal(text, 'look @bin.png');
    assert.deepEqual(mentions.map(m => m.outcome), ['unreadable']);
  });

  it('announces an oversized file without inlining it', () => {
    writeFileSync(join(root, 'big.log'), 'x'.repeat(300 * 1024));
    const { text, mentions } = expandFileMentions('@big.log', root);
    assert.equal(text, '@big.log');
    assert.deepEqual(mentions.map(m => m.outcome), ['too-large']);
  });

  it('never touches @ inside a word', () => {
    const { text, mentions } = expandFileMentions('mail me@example.com', root);
    assert.equal(text, 'mail me@example.com');
    assert.deepEqual(mentions, []);
  });

  it('refuses paths that escape the root', () => {
    const { mentions } = expandFileMentions('@../outside.txt', root);
    assert.deepEqual(mentions, []);
  });
});
