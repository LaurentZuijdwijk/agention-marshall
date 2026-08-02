import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clipboardCandidates, sniffMimeType, readClipboardImage } from './clipboard.js';
import type { RunCommand } from './clipboard.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(8)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(8)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(4)]);

/** A fake clipboard: only `cmd` succeeds, and it returns `bytes`. */
const only = (cmd: string, bytes: Buffer): RunCommand & { calls: string[] } => {
  const calls: string[] = [];
  const run = ((c: string) => {
    calls.push(c);
    return c === cmd ? { ok: true, stdout: bytes } : { ok: false, stdout: Buffer.alloc(0) };
  }) as RunCommand & { calls: string[] };
  run.calls = calls;
  return run;
};

describe('clipboardCandidates', () => {
  it('prefers wl-paste on a wayland session, and still keeps xclip', () => {
    const order = clipboardCandidates('linux', { XDG_SESSION_TYPE: 'wayland' }).map(c => c.cmd);
    assert.deepEqual(order, ['wl-paste', 'xclip']);
  });

  it('prefers xclip on X11', () => {
    const order = clipboardCandidates('linux', { XDG_SESSION_TYPE: 'x11' }).map(c => c.cmd);
    assert.deepEqual(order, ['xclip', 'wl-paste']);
  });

  it('treats a WAYLAND_DISPLAY as a wayland session', () => {
    assert.equal(clipboardCandidates('linux', { WAYLAND_DISPLAY: 'wayland-0' })[0].cmd, 'wl-paste');
  });

  it('uses the platform helper on macOS and Windows', () => {
    assert.equal(clipboardCandidates('darwin', {})[0].cmd, 'pngpaste');
    assert.equal(clipboardCandidates('win32', {})[0].cmd, 'powershell');
  });
});

describe('sniffMimeType', () => {
  it('recognises the four formats every provider takes', () => {
    assert.equal(sniffMimeType(PNG), 'image/png');
    assert.equal(sniffMimeType(JPEG), 'image/jpeg');
    assert.equal(sniffMimeType(GIF), 'image/gif');
    assert.equal(sniffMimeType(WEBP), 'image/webp');
  });

  it('rejects anything else, rather than guessing', () => {
    assert.equal(sniffMimeType(Buffer.from('this is plain text, not an image')), null);
    assert.equal(sniffMimeType(Buffer.from([0x89, 0x50])), null, 'too short to tell');
  });
});

describe('readClipboardImage', () => {
  it('returns the image, base64-encoded, with the sniffed type', () => {
    const result = readClipboardImage('linux', only('wl-paste', PNG), { XDG_SESSION_TYPE: 'wayland' });
    assert.ok('image' in result);
    assert.equal(result.image.mimeType, 'image/png');
    assert.equal(Buffer.from(result.image.data, 'base64').equals(PNG), true);
  });

  it('trusts the bytes over the format it asked for', () => {
    // Every helper is asked for PNG; pngpaste and friends do not have to comply.
    const result = readClipboardImage('linux', only('wl-paste', JPEG), { XDG_SESSION_TYPE: 'wayland' });
    assert.ok('image' in result);
    assert.equal(result.image.mimeType, 'image/jpeg');
  });

  it('falls through to the next helper when the first is missing', () => {
    const run = only('xclip', PNG);
    const result = readClipboardImage('linux', run, { XDG_SESSION_TYPE: 'wayland' });
    assert.deepEqual(run.calls, ['wl-paste', 'xclip'], 'tried both, in order');
    assert.ok('image' in result);
  });

  it('names what to install when nothing worked', () => {
    const result = readClipboardImage('linux', only('nothing', PNG), { XDG_SESSION_TYPE: 'wayland' });
    assert.ok('error' in result);
    assert.match(result.error, /No image on the clipboard/);
    assert.match(result.error, /wl-clipboard/);
  });

  it('says so when the clipboard holds something that is not an image', () => {
    const run = only('wl-paste', Buffer.from('just some copied text here'));
    const result = readClipboardImage('linux', run, { XDG_SESSION_TYPE: 'wayland' });
    assert.ok('error' in result);
    assert.match(result.error, /not a PNG, JPEG, GIF or WebP/);
  });

  it('treats an empty result as an empty clipboard, not a failure to report', () => {
    const run = ((): { ok: boolean; stdout: Buffer } => ({ ok: true, stdout: Buffer.alloc(0) })) as RunCommand;
    const result = readClipboardImage('linux', run, { XDG_SESSION_TYPE: 'wayland' });
    assert.ok('error' in result);
    assert.match(result.error, /No image on the clipboard/);
  });
});
