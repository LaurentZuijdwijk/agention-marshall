#!/usr/bin/env node
// Run marshall under a watchdog that captures a JS stack when the UI freezes.
//
// The freeze we're chasing is a synchronous allocation loop: the event loop is
// blocked, so nothing inside the process can report on itself. This spawns the
// CLI as a child with the TTY passed straight through (the UI behaves exactly
// as normal) and watches its memory from the outside. When RSS crosses the
// threshold — long before V8 dies, so the process is still alive to answer —
// it sends SIGUSR2, which Node handles by writing a diagnostic report
// containing the JavaScript stack of whatever is currently running.
//
//   node scripts/debug-freeze.mjs [workspace]
//
// Reproduce the freeze, then send the printed report path.

import { spawn } from 'node:child_process';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const REPORT = join(tmpdir(), 'marshall-freeze.json');
const LIMIT_MB = 700;    // well above normal (~60MB), well below the heap cap
const POLL_MS = 250;

rmSync(REPORT, { force: true });

const child = spawn(
  process.execPath,
  ['--import', 'tsx/esm',
   '--report-on-signal', '--report-signal=SIGUSR2',
   `--report-directory=${tmpdir()}`, '--report-filename=marshall-freeze.json',
   join(here, '..', 'src', 'index.tsx'),
   ...process.argv.slice(2)],
  { cwd: join(here, '..'), stdio: 'inherit' },
);

const rssMb = (pid) => {
  try {
    // statm field 2 is resident pages.
    return (Number(readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1]) * 4096) / 1048576;
  } catch {
    return 0;
  }
};

let fired = false;
const timer = setInterval(() => {
  if (fired || child.exitCode !== null) return;
  const mb = rssMb(child.pid);
  if (mb > LIMIT_MB) {
    fired = true;
    process.stderr.write(`\n[watchdog] RSS ${mb.toFixed(0)}MB — capturing stack…\n`);
    child.kill('SIGUSR2');
    setTimeout(() => {
      process.stderr.write(
        existsSync(REPORT)
          ? `[watchdog] report written: ${REPORT}\n`
          : `[watchdog] no report produced\n`,
      );
      child.kill('SIGKILL');
    }, 3000);
  }
}, POLL_MS);

child.on('exit', (code) => {
  clearInterval(timer);
  if (existsSync(REPORT)) process.stderr.write(`\n[watchdog] report at ${REPORT}\n`);
  process.exit(code ?? 0);
});
