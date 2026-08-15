import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicWrite } from './atomic-write.js';

test('atomicWrite preserves existing file permissions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'marshall-atomic-write-test-'));
  const file = join(root, 'file.txt');
  await atomicWrite(file, 'first');
  chmodSync(file, 0o640);
  await atomicWrite(file, 'second');
  assert.equal(statSync(file).mode & 0o777, 0o640);
});
