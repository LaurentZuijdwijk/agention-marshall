import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const extension = new URL('../../browser-extension/', import.meta.url);
execFileSync(process.execPath, ['esbuild.config.mjs'], {
  cwd: fileURLToPath(extension), stdio: 'inherit',
});
const dist = new URL('dist/', extension);
const files = Object.fromEntries(readdirSync(dist).sort()
  .filter(name => !name.endsWith('.map'))
  .map(name => [name, readFileSync(new URL(name, dist))]));
mkdirSync(new URL('../dist/', import.meta.url), { recursive: true });
writeFileSync(new URL('../dist/marshall-browser-extension.zip', import.meta.url), zipSync(files));
