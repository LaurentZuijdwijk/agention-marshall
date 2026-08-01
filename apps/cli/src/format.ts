// ── display formatting helpers (pure logic, testable) ─────────────────────────

/**
 * Keys that carry the "what is this call actually doing" information. When a
 * tool input has one of these we show it verbatim instead of dumping JSON —
 * `read_file  src/App.tsx` reads far better than `read_file  {"path":"src/…`.
 */
const PRIMARY_KEYS = ['command', 'path', 'file_path', 'pattern', 'query', 'url', 'task'];

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + '…';
}

function scalar(value: unknown): string {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ');
  if (Array.isArray(value)) return `[${value.length}]`;
  if (value && typeof value === 'object') return '{…}';
  return String(value);
}

/** Render a tool's input as a single compact, human-readable line. */
export function formatToolInput(input: unknown, max = 96): string {
  if (input == null || typeof input !== 'object') return '';

  const obj = input as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return '';

  const primary = PRIMARY_KEYS.find(k => typeof obj[k] === 'string' && obj[k] !== '');
  const text = primary
    ? scalar(obj[primary]) + (keys.length > 1 ? `  +${keys.length - 1}` : '')
    : keys.map(k => `${k}=${scalar(obj[k])}`).join(' ');

  return truncate(text, max);
}

/**
 * Shorten a path for the header: collapse $HOME to `~`, then elide leading
 * segments if it is still too long, keeping the tail (which is what identifies
 * the project).
 */
export function shortenPath(path: string, home?: string, max = 64): string {
  let out = home && path.startsWith(home) ? '~' + path.slice(home.length) : path;
  if (out.length <= max) return out;

  const parts = out.split('/');
  while (parts.length > 2 && parts.join('/').length > max) parts.shift();
  return '…/' + parts.join('/');
}

/** Split a `provider/model` style label so each half can be coloured. */
export function splitModelLabel(provider: string, model?: string): [string, string] {
  return [provider, model ?? 'default'];
}
