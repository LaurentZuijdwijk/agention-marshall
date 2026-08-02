// ── @file completion and expansion (pure logic, testable) ─────────────────────
//
// Typing `@` starts a file reference; Tab completes it one path segment at a
// time, the way a shell would. On submit every complete `@path` in the text is
// read and inlined, so the model sees the contents rather than a path it would
// have to spend a read_file call on. A mention pointing at an image is read as
// base64 instead, for the caller to hand off to the same attachment path a
// clipboard-pasted image travels.
//
// Reads are synchronous on purpose: the completion memo runs on every render
// (which a streamed response triggers constantly), and expansion runs once on
// the submit path. A missed cache would show a stale directory, which is worse
// than the microsecond a readdir costs.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { IMAGE_MIME_TYPES, MAX_IMAGE_BYTES } from '@agentionai/marshall-engine';
import type { ImageAttachment } from '@agentionai/marshall-engine';

/** Directories nobody means to complete into — `.git` above all. */
const SKIP_DIRS = new Set(['.git']);

/** Past this a mention stays a path: inlining would bury the actual task. */
const MAX_MENTION_BYTES = 256 * 1024;
const MAX_MENTION_CHARS = 64 * 1024;

/** Extensions recognised as images, mapped to the mime type the engine expects. */
const IMAGE_EXTENSIONS: Record<string, ImageAttachment['mimeType']> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** The mime type a mention's extension implies, or null when it names no known image type. */
function imageMimeType(path: string): ImageAttachment['mimeType'] | null {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return null;
  const mime = IMAGE_EXTENSIONS[path.slice(dot + 1).toLowerCase()];
  return mime && IMAGE_MIME_TYPES.includes(mime) ? mime : null;
}

/** A `@path` mention that resolves to a real file. */
export interface FileMention {
  /** The mention as typed, `@` included — this is the text that gets replaced. */
  token: string;
  /** Where the token sits in the original text. */
  start: number;
  /** Where the file's contents were inlined, or why they were not. */
  outcome: 'ok' | 'image' | 'too-large' | 'unreadable';
  /** Bytes on disk — reported so the announce row can name the size. */
  bytes: number;
  /** The file's text; only set when outcome is 'ok'. */
  content?: string;
  /** The image payload; only set when outcome is 'image'. The caller attaches
   *  it the same way a pasted image is attached, replacing the mention with
   *  the label that comes back. */
  image?: ImageAttachment;
}

export interface MentionExpansion {
  /** The task with every readable mention replaced by its contents. */
  text: string;
  /** One entry per resolved file, for the transcript row that announces them. */
  mentions: FileMention[];
}

/**
 * The `@path` the user is currently typing — a bare `@` or one preceded by
 * whitespace, running to the end of the input. `@` inside a word (an email, a
 * scoped package) is not a file reference.
 */
export function trailingAtToken(input: string): { token: string; start: number } | null {
  const at = input.lastIndexOf('@');
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(input[at - 1]!)) return null;
  const token = input.slice(at + 1);
  if (/\s/.test(token)) return null;
  return { token, start: at };
}

/** A token points into a real directory — one with completable entries. */
function listable(root: string, dirRel: string): string | null {
  if (dirRel.split('/').includes('..')) return null;
  const abs = join(root, dirRel);
  try {
    if (!statSync(abs).isDirectory()) return null;
  } catch {
    return null;
  }
  return abs;
}

function entries(abs: string): { files: string[]; dirs: string[] } {
  const files: string[] = [];
  const dirs: string[] = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) dirs.push(entry.name);
    } else if (entry.isFile()) {
      files.push(entry.name);
    }
  }
  files.sort();
  dirs.sort();
  return { files, dirs };
}

function commonPrefix(strings: string[]): string {
  if (strings.length === 0) return '';
  let prefix = strings[0]!;
  for (const s of strings.slice(1)) {
    while (!s.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return prefix;
}

/**
 * Ghost text completing the `@path` at the end of `input`, or '' when there is
 * nothing unambiguous to add. Pure prefix matching, one directory at a time:
 * complete to the longest common prefix, expose one directory's trailing `/`
 * at a time so Tab walks down the tree, and stop at a unique file. An exact
 * directory name completes to its `/` — typing on then lists what's inside.
 */
export function completeAtPath(input: string, root: string): string {
  const found = trailingAtToken(input);
  if (!found) return '';
  let token = found.token;
  if (token.startsWith('~/')) token = join(homedir(), token.slice(2));

  const slash = token.lastIndexOf('/');
  const dirRel = slash === -1 ? '' : token.slice(0, slash + 1);
  const prefix = slash === -1 ? token : token.slice(slash + 1);

  const abs = listable(root, dirRel);
  if (!abs) return '';
  let listing: { files: string[]; dirs: string[] };
  try {
    listing = entries(abs);
  } catch {
    return '';
  }

  const dirs = listing.dirs.filter(d => d.startsWith(prefix));
  const files = listing.files.filter(f => f.startsWith(prefix));
  const common = commonPrefix([...dirs, ...files]);
  let ghost = common.slice(prefix.length);

  if (dirs.length === 1 && files.length === 0 && common === dirs[0]) ghost += '/';
  if (ghost) return ghost;

  // Nothing to add to the prefix — but an exact directory opens up.
  if (prefix !== '' && dirs.length === 1 && dirs[0] === prefix && files.length === 0) return '/';
  return '';
}

/**
 * Replace every complete `@path` in `text` with the file's contents.
 *
 * The mention stays visible as the fence's title line, so the user can still
 * see what they referenced and the model can name the file back. Files that
 * cannot be inlined — missing, a directory, binary, huge — are left as typed;
 * the agent can still reach them with read_file, and a file that never
 * resolved in the first place produces no mention and no announcement.
 *
 * A mention that names an image is left as typed too: it is not inlined into
 * `text` here, since turning it into the `[image #N]` label it needs requires
 * the caller's attachment store. Its data travels on the mention instead, for
 * the caller to attach and splice in.
 */
export function expandFileMentions(text: string, root: string): MentionExpansion {
  const mentions: FileMention[] = [];
  let out = '';
  let last = 0;
  // Same rule as trailingAtToken, everywhere in the text: `@` at the start or
  // after whitespace, then a run of non-space characters.
  const pattern = /(^|\s)@(\S+)/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const token = match[2]!;
    const start = match.index + match[1]!.length;
    let rel = token;
    if (rel.startsWith('~/')) rel = join(homedir(), rel.slice(2));
    if (rel.split('/').includes('..')) continue;

    const abs = join(root, rel);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    const mention: FileMention = { token: `@${token}`, start, outcome: 'ok', bytes: stat.size };
    const mimeType = imageMimeType(rel);
    if (mimeType) {
      if (stat.size > MAX_IMAGE_BYTES) {
        mention.outcome = 'too-large';
      } else {
        try {
          mention.outcome = 'image';
          mention.image = { data: readFileSync(abs).toString('base64'), mimeType };
        } catch {
          mention.outcome = 'unreadable';
        }
      }
    } else if (stat.size > MAX_MENTION_BYTES) {
      mention.outcome = 'too-large';
    } else {
      try {
        const content = readFileSync(abs, 'utf8');
        if (content.includes(String.fromCharCode(0))) {
          mention.outcome = 'unreadable';
        } else {
          mention.content =
            content.length > MAX_MENTION_CHARS ? content.slice(0, MAX_MENTION_CHARS) : content;
        }
      } catch {
        mention.outcome = 'unreadable';
      }
    }

    mentions.push(mention);
    if (mention.outcome === 'ok') {
      out += text.slice(last, start);
      last = start + mention.token.length;
      const body = mention.content!.endsWith('\n')
        ? mention.content!.slice(0, -1)
        : mention.content!;
      out += `\`${mention.token.slice(1)}\`:\n\n\`\`\`\n${body}\n\`\`\``;
    }
  }

  if (last === 0) return { text, mentions };
  return { text: out + text.slice(last), mentions };
}
