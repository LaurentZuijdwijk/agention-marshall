import { open } from 'node:fs/promises';

export const DEFAULT_MAX_FILE_BYTES = 256 * 1024; // 256 KiB
const TRUNCATION_MARKER = '\n[...file truncated — content exceeds read limit...]';

export interface CappedReadResult {
  content: string;
  /** The file is larger than `maxBytes`; `content` is a prefix of it. */
  truncated: boolean;
  /**
   * A NUL byte appeared in what was read — the test `grep` uses to call a file
   * binary. Callers that render matches to a model want to skip these: the
   * bytes decode to replacement characters and land in its context as noise.
   */
  binary: boolean;
}

/**
 * Read up to `maxBytes` of a file, reporting what was cut rather than saying so
 * inside the content.
 *
 * Prefer this to `cappedRead` anywhere the result is scanned rather than shown.
 * The marker `cappedRead` appends is indistinguishable from a line of the file
 * once it is in the string: a search over it matches the marker's own words and
 * reports a hit at a line number the file does not have.
 */
export async function cappedReadPart(
  filePath: string,
  maxBytes: number = DEFAULT_MAX_FILE_BYTES,
): Promise<CappedReadResult> {
  const handle = await open(filePath, 'r');
  try {
    // Read one extra byte to detect truncation without a stat() round-trip
    const buf = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buf, 0, maxBytes + 1, 0);
    const bytes = buf.subarray(0, Math.min(bytesRead, maxBytes));
    return {
      content: bytes.toString('utf8'),
      truncated: bytesRead > maxBytes,
      binary: bytes.includes(0),
    };
  } finally {
    await handle.close();
  }
}

/**
 * Read up to `maxBytes` of a file. Appends a truncation marker if the file
 * is larger so the model knows the content is incomplete.
 */
export async function cappedRead(
  filePath: string,
  maxBytes: number = DEFAULT_MAX_FILE_BYTES,
): Promise<string> {
  const { content, truncated } = await cappedReadPart(filePath, maxBytes);
  return truncated ? content + TRUNCATION_MARKER : content;
}
