import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

export interface CheckResult {
  pass: boolean;
  summary: string;
}

/** Runs node's built-in test runner in `workspaceDir` and reports pass/fail. */
async function runNodeTests(workspaceDir: string, _response: string): Promise<CheckResult> {
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
  // Node's test runner prints its summary as `ℹ tests N` on current versions
  // and `# tests N` on older ones; anchoring on only one silently degrades the
  // summary to "last six lines" on the other.
  const summaryStart = lines.findIndex(l => l.startsWith('# tests') || l.startsWith('\u2139 tests'));
  return summaryStart >= 0 ? lines.slice(summaryStart).join(' | ') : lines.slice(-6).join(' | ');
}

/**
 * Verifies the multi-file logging migration.
 *
 * Green tests alone are not enough. They would also pass if the agent deleted
 * the vendored decoy's unrelated `log` function, or left `legacy-log.js` behind
 * with nothing importing it — both of which are ways of finishing the task
 * without doing it. Each condition is reported separately so a failure says
 * which one broke rather than just "tests failed".
 */
async function checkMigration(workspaceDir: string, _response: string): Promise<CheckResult> {
  const problems: string[] = [];
  const srcDir = join(workspaceDir, 'src');

  let entries: string[] = [];
  try {
    entries = (await readdir(srcDir, { withFileTypes: true }))
      .filter(e => e.isFile() && e.name.endsWith('.js'))
      .map(e => e.name);
  } catch {
    return { pass: false, summary: 'src/ is missing' };
  }

  if (entries.includes('legacy-log.js')) problems.push('src/legacy-log.js still present');

  const residual: string[] = [];
  for (const name of entries) {
    if (name === 'legacy-log.js' || name === 'logger.js') continue;
    const text = await readFile(join(srcDir, name), 'utf8');
    if (/\blog\(/.test(text)) residual.push(name);
  }
  if (residual.length) problems.push(`still calls log(): ${residual.slice(0, 5).join(', ')}${residual.length > 5 ? ` +${residual.length - 5}` : ''}`);

  // Compared against the generated fixture rather than a hash literal, so
  // regenerating the fixture at a different size can never invalidate this.
  const vendorRelative = join('src', 'vendor', 'table.js');
  const pristine = await readFile(join(__dirname, 'fixtures', 'multi-file-migration', vendorRelative), 'utf8');
  const actual = await readFile(join(workspaceDir, vendorRelative), 'utf8').catch(() => null);
  if (actual === null) problems.push('src/vendor/table.js was deleted');
  else if (actual !== pristine) problems.push('src/vendor/table.js was modified');

  const tests = await runNodeTests(workspaceDir, '');
  if (!tests.pass) problems.push(tests.summary);

  return { pass: problems.length === 0, summary: problems.length ? problems.join(' | ') : tests.summary };
}

/** Runs the real @agentionai/marshall-engine package's own test suite (TS, via tsx) inside a
 *  copied repo snapshot — used by the real-repo task. */
async function runEngineTests(workspaceDir: string, _response: string): Promise<CheckResult> {
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
  /**
   * Decides pass/fail. `workspaceDir` is the (possibly edited) fixture copy;
   * `response` is the agent's final chat message, verbatim — the only thing a
   * question-answering task has to check, since it never touches the
   * workspace. A code-editing task's check ignores `response` and runs real
   * tests instead; see `runNodeTests`. Either way, this is a fixed,
   * deterministic function — never an LLM judge — so a task's pass/fail is
   * exactly as reproducible as the check function reads on the page.
   */
  check(workspaceDir: string, response: string): Promise<CheckResult>;
}

/**
 * A question-answering check: the workspace is never touched, so the only
 * thing to verify is whether the required facts appear in what the agent
 * said. Each pattern must match somewhere in the response — order and
 * phrasing are free, but literal content is not.
 *
 * Deliberately just as strict as it looks: a benchmark whose Q&A check is "an
 * LLM judge thinks this looks right" is scoring the judge, not the agent.
 */
function answerContains(...required: RegExp[]): (workspaceDir: string, response: string) => Promise<CheckResult> {
  return async (_workspaceDir, response) => {
    const missing = required.filter(pattern => !pattern.test(response));
    return {
      pass: missing.length === 0,
      summary: missing.length === 0
        ? 'answer contains all required facts'
        : `missing from answer: ${missing.map(p => p.source).join(', ')} | full answer: ${response.slice(0, 300)}`,
    };
  };
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
  // ── question-answering: no edits, the workspace is a trap ──────────────────
  //
  // Both fixtures are the exact adversarial shapes that broke a dedicated
  // search tool in two other agent harnesses during testing on 2026-08-19:
  // a file just over the read/search byte cap whose only "hit" for a plausible
  // query is inside a truncation marker, and a single-line minified file whose
  // one interesting token sits deep enough in that naive truncation clips past
  // it. Read `docs/competitive-findings.md` for what that looked like without
  // the fix these tasks now guard.
  {
    id: 'qa-large-log',
    fixtureDir: 'qa-large-log',
    prompt: "Does this codebase contain the word 'exceeds' anywhere? If so, in which file and on what line?",
    // The real content of big.log never contains "exceeds" — only a stale,
    // uncapped truncation notice would. A correct answer says no; a tool that
    // scans its own truncation marker as file content says yes.
    check: answerContains(/\bno\b/i),
  },
  {
    id: 'qa-minified-token',
    fixtureDir: 'qa-minified-token',
    prompt: 'What is the unique token in bundle.min.js, and on what line does it appear?',
    check: answerContains(/UNIQUE_TOKEN_ABC123/, /\bline\s*1\b/i),
  },
  {
    // The long one. ~30 modules, ~115 call sites, and no way to finish without
    // reading most of the tree — which is the point: the other tasks here run
    // 5-8 tool calls and never reach the regime where context growth matters.
    // Generated by scripts/build-migration-fixture.mjs; regenerate it if the
    // size needs to change rather than editing modules by hand.
    id: 'multi-file-migration',
    fixtureDir: 'multi-file-migration',
    prompt: 'This project is midway through a logging migration. MIGRATION.md describes the rules. '
      + 'Finish it: migrate every remaining call site off the deprecated log() helper and delete '
      + 'src/legacy-log.js. When you are done, `node --test` must pass.',
    check: checkMigration,
  },
  {
    // Same fixture, but the codemod route closed off.
    //
    // Left free, a model reads five or six modules, infers the rule, and writes
    // a script to apply it to the rest — which is a perfectly good way to do the
    // job, and was what happened on the first run: 8 reads, 32 tool calls, a
    // 35k peak. It is not, however, the regime this task exists to measure. The
    // MIGRATION.md rule is precisely specified, which is exactly what makes it
    // programmable; rather than make the spec vaguer (and the check unfair),
    // this variant simply asks for the edits directly. Run both: the pair shows
    // what the shortcut is worth as well as what the long path costs.
    id: 'multi-file-migration-manual',
    fixtureDir: 'multi-file-migration',
    prompt: 'This project is midway through a logging migration. MIGRATION.md describes the rules. '
      + 'Finish it: migrate every remaining call site off the deprecated log() helper and delete '
      + 'src/legacy-log.js. Edit each source file directly with your editing tools — do not write '
      + 'a migration script, and do not use sed, awk or similar batch text tools. '
      + 'When you are done, `node --test` must pass.',
    check: checkMigration,
  },
  {
    id: 'real-repo-fix',
    // Absolute path — a full snapshot of the real monorepo, not a small hand-built
    // fixture. Built by copying the working repo (see conversation notes) with
    // node_modules symlinked back to the original to avoid a full reinstall.
    fixtureDir: '/tmp/marshall-realrepo-baseline',
    prompt: "The @agentionai/marshall-engine package's test suite (packages/engine) has one failing test. Find it, understand why it fails, and fix it so the full suite passes. Don't delete or skip the failing test to make it pass.",
    check: runEngineTests,
  },
];
