import { readFileSync, writeFileSync, chmodSync } from 'node:fs';

const entry = 'dist/index.js';
const content = readFileSync(entry, 'utf8');
if (!content.startsWith('#!')) {
  writeFileSync(entry, '#!/usr/bin/env node\n' + content);
}
chmodSync(entry, 0o755);
