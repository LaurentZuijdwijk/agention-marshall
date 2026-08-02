// ── reading an image off the system clipboard ─────────────────────────────────
//
// Terminal paste cannot carry an image. Bracketed paste is a text protocol —
// the bytes on the clipboard never reach stdin, which is why this asks the OS
// directly instead of going through the input box.
//
// Every platform needs a different helper and none of them ship everywhere, so
// the candidates are tried in order and a miss reports what to install rather
// than failing silently.

import { spawnSync } from 'node:child_process';
import type { ImageAttachment } from '@agentionai/marshall-engine';

/** Runs a command and hands back its raw stdout — injected so tests need no clipboard. */
export type RunCommand = (cmd: string, args: string[]) => { ok: boolean; stdout: Buffer };

export const runCommand: RunCommand = (cmd, args) => {
  const result = spawnSync(cmd, args, { maxBuffer: 32 * 1024 * 1024 });
  return { ok: result.status === 0 && !result.error, stdout: result.stdout ?? Buffer.alloc(0) };
};

interface Candidate {
  cmd: string;
  args: string[];
  /** Shown when no candidate produced anything and this one was missing. */
  install: string;
}

/**
 * Which helpers to try, most likely first.
 *
 * Wayland and X11 are told apart by the session type rather than probed, since
 * `wl-paste` exists on plenty of X11 systems and simply fails there.
 */
export function clipboardCandidates(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined> = process.env,
): Candidate[] {
  if (platform === 'darwin') {
    return [{ cmd: 'pngpaste', args: ['-'], install: 'brew install pngpaste' }];
  }
  if (platform === 'win32') {
    return [{
      cmd: 'powershell',
      args: ['-NoProfile', '-Command',
        '$i=Get-Clipboard -Format Image; if($i){$s=New-Object IO.MemoryStream; $i.Save($s,[Drawing.Imaging.ImageFormat]::Png); [Console]::OpenStandardOutput().Write($s.ToArray(),0,$s.Length)}'],
      install: 'PowerShell (built in)',
    }];
  }
  const wayland = env.WAYLAND_DISPLAY || env.XDG_SESSION_TYPE === 'wayland';
  const wl: Candidate = { cmd: 'wl-paste', args: ['--type', 'image/png'], install: 'sudo apt install wl-clipboard' };
  const x11: Candidate = { cmd: 'xclip', args: ['-selection', 'clipboard', '-t', 'image/png', '-o'], install: 'sudo apt install xclip' };
  return wayland ? [wl, x11] : [x11, wl];
}

/**
 * The image format, read from the bytes rather than assumed.
 *
 * Every helper above is asked for PNG, but they are not all obliged to agree —
 * pngpaste re-encodes, and a clipboard holding a JPEG can come back as one.
 * Sending the wrong mime type is a provider error, so the bytes decide.
 */
export function sniffMimeType(bytes: Buffer): ImageAttachment['mimeType'] | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF'
    && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

export type ClipboardResult =
  | { image: ImageAttachment }
  /** Nothing usable — `message` is written for the user, not for a log. */
  | { error: string };

export function readClipboardImage(
  platform: NodeJS.Platform = process.platform,
  run: RunCommand = runCommand,
  env: Record<string, string | undefined> = process.env,
): ClipboardResult {
  const candidates = clipboardCandidates(platform, env);
  if (candidates.length === 0) {
    return { error: `No clipboard helper is known for ${platform}.` };
  }

  for (const candidate of candidates) {
    const { ok, stdout } = run(candidate.cmd, candidate.args);
    // A helper that runs and returns nothing means an empty clipboard, or one
    // holding text — not a broken setup, so keep trying the others quietly.
    if (!ok || stdout.length === 0) continue;

    const mimeType = sniffMimeType(stdout);
    if (!mimeType) {
      return { error: 'The clipboard has data but it is not a PNG, JPEG, GIF or WebP image.' };
    }
    return { image: { data: stdout.toString('base64'), mimeType } };
  }

  return {
    error: `No image on the clipboard. If you copied one, install a clipboard helper: ${
      candidates.map(c => c.install).join(', or ')}.`,
  };
}
