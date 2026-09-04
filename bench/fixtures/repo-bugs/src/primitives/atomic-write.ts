import { writeFile, rename, mkdir, rm, stat, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Write `content` to `filePath` atomically (temp file + rename).
 * Creates parent directories if needed.
 * Safe to interrupt: a partial write never lands at the target path.
 */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });

  // A rename replaces the destination and therefore would otherwise reset its
  // mode to the temporary file's default (typically 0o666 & umask). Preserve
  // the existing permissions when updating an already-created file.
  let mode: number | undefined;
  try {
    mode = (await stat(filePath)).mode & 0o7777;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  // Use the same directory so rename is on the same filesystem (atomic)
  const tmpPath = join(dirname(filePath), `.tmp-${randomUUID()}`);
  try {
    await writeFile(tmpPath, content, mode === undefined ? 'utf8' : { encoding: 'utf8', mode });
    // Before the rename, not after: the rename is the moment the file becomes
    // visible at its real path, so anything done afterwards leaves a window
    // where it is readable with the temporary file's mode. `writeFile`'s own
    // `mode` is masked by the umask, which is why it is set again explicitly.
    if (mode !== undefined) await chmod(tmpPath, mode);
    await rename(tmpPath, filePath);
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}
