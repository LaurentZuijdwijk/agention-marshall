// Bundles every entry point as an IIFE, not ESM: MV3 content scripts are
// always loaded as classic scripts (no import/export support), and the
// background service worker here declares no "type": "module" either, so
// staying IIFE everywhere keeps one build path instead of two.
import { build } from 'esbuild';
import { mkdirSync, copyFileSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });

await build({
  entryPoints: [
    'src/background.ts',
    'src/console-capture-main.ts',
    'src/console-capture-relay.ts',
    'src/overlay.ts',
    'src/popup.ts',
  ],
  outdir: 'dist',
  bundle: true,
  format: 'iife',
  target: 'chrome110',
  platform: 'browser',
  sourcemap: true,
  logLevel: 'info',
});

copyFileSync('manifest.json', 'dist/manifest.json');
copyFileSync('src/popup.html', 'dist/popup.html');

console.log('\nBuilt to dist/ — chrome://extensions → Developer mode → Load unpacked → pick this dist/ folder.');
