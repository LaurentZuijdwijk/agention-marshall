import { open } from 'node:fs/promises';

export const DEFAULT_MAX_FILE_BYTES = 256 * 1024; // 256 KiB
const TRUNCATION_MARKER = '\n[...file truncated — content exceeds read limit...]';

/**
 * Read up to `maxBytes` of a file. Appends a truncation marker if the file
 * is larger so the model knows the content is incomplete.
 */
export async function cappedRead(
  filePath: string,
  maxBytes: number = DEFAULT_MAX_FILE_BYTES,
): Promise<string> {
  const handle = await open(filePath, 'r');
  try {
    // Read one extra byte to detect truncation without a stat() round-trip
    const buf = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buf, 0, maxBytes + 1, 0);
    const content = buf.subarray(0, Math.min(bytesRead, maxBytes)).toString('utf8');
    return bytesRead > maxBytes ? content + TRUNCATION_MARKER : content;
  } finally {
    await handle.close();
  }
}
