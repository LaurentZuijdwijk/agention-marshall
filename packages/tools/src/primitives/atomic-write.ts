import { writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Write `content` to `filePath` atomically (temp file + rename).
 * Creates parent directories if needed.
 * Safe to interrupt: a partial write never lands at the target path.
 */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });

  // Use the same directory so rename is on the same filesystem (atomic)
  const tmpPath = join(dirname(filePath), `.tmp-${randomUUID()}`);
  try {
    await writeFile(tmpPath, content, 'utf8');
    await rename(tmpPath, filePath);
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}
