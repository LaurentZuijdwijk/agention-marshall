import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

export interface CheckResult {
  pass: boolean;
  summary: string;
}

/** Runs node's built-in test runner in `workspaceDir` and reports pass/fail. */
async function runNodeTests(workspaceDir: string): Promise<CheckResult> {
  try {
    const { stdout } = await execFileAsync('node', ['--test'], { cwd: workspaceDir, timeout: 30_000 });
    return { pass: true, summary: tail(stdout) };
  } catch (err) {
    const stdout = (err as { stdout?: string }).stdout ?? String(err);
    return { pass: false, summary: tail(stdout) };
  }
}

function tail(output: string): string {
  const lines = output.trim().split('\n');
  const summaryStart = lines.findIndex(l => l.startsWith('# tests'));
  return summaryStart >= 0 ? lines.slice(summaryStart).join(' | ') : lines.slice(-6).join(' | ');
}

/** Runs the real @marshall/engine package's own test suite (TS, via tsx) inside a
 *  copied repo snapshot — used by the real-repo task. */
async function runEngineTests(workspaceDir: string): Promise<CheckResult> {
  const engineDir = join(workspaceDir, 'packages', 'engine');
  try {
    const { stdout } = await execFileAsync(
      'node',
      ['--import', 'tsx/esm', '--test', 'src/**/*.test.ts'],
      { cwd: engineDir, timeout: 60_000 },
    );
    return { pass: true, summary: tail(stdout) };
  } catch (err) {
    const stdout = (err as { stdout?: string }).stdout ?? String(err);
    return { pass: false, summary: tail(stdout) };
  }
}

export interface BenchTask {
  id: string;
  /** Directory name under bench/fixtures/ holding the starting workspace state. */
  fixtureDir: string;
  /** Prompt handed to the agent verbatim. */
  prompt: string;
  check(workspaceDir: string): Promise<CheckResult>;
}

export const TASKS: BenchTask[] = [
  {
    id: 'bug-fix',
    fixtureDir: 'bug-fix',
    prompt: 'The test suite is failing. Find and fix the bug in src/sum.js so all tests pass. Do not modify the test file.',
    check: runNodeTests,
  },
  {
    id: 'feature-add',
    fixtureDir: 'feature-add',
    prompt: 'Implement the titleCase(str) function in src/stringUtils.js per the spec comment above it, so the tests in src/stringUtils.test.js pass. Do not modify the test file.',
    check: runNodeTests,
  },
  {
    id: 'refactor',
    fixtureDir: 'refactor',
    prompt: "Rename the exported function `getTotal` to `calculateTotal` everywhere it's defined and used under src/, so the tests pass. Don't change behavior.",
    check: runNodeTests,
  },
  {
    id: 'iterate',
    fixtureDir: 'iterate',
    prompt: 'Multiple tests are failing in src/validator.test.js. Run the tests, find all the bugs in src/validator.js, and fix them one by one until the full suite passes.',
    check: runNodeTests,
  },
  {
    id: 'real-repo-fix',
    // Absolute path — a full snapshot of the real monorepo, not a small hand-built
    // fixture. Built by copying the working repo (see conversation notes) with
    // node_modules symlinked back to the original to avoid a full reinstall.
    fixtureDir: '/tmp/marshall-realrepo-baseline',
    prompt: "The @marshall/engine package's test suite (packages/engine) has one failing test. Find it, understand why it fails, and fix it so the full suite passes. Don't delete or skip the failing test to make it pass.",
    check: runEngineTests,
  },
];
