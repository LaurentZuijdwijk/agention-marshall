// ── ad hoc live test: does list_conflicts/resolve_conflict change how well a
// real model resolves a merge conflict, versus read_file/edit_file alone? ──
//
// Not part of the test suite — this hits a real model over the network (no
// fake server), so it costs money and is not CI-safe. Run it by hand:
//   node --import tsx/esm packages/engine/scripts/live-conflict-tool-test.ts
//
// Point MARSHALL_LIVE_MODEL / MARSHALL_LIVE_PROVIDER at a different model
// without editing this file; MARSHALL_LIVE_HOST for a local provider
// (llamacpp/ollama) that isn't on its default port. OpenRouter runs read the
// key from $OPENROUTER_API_KEY, falling back to ~/.config/marshall/config.json
// — local providers need no key.

import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { History, ToolResultEvent } from '@agentionai/agents/core';
import type { Tool } from '@agentionai/agents/core';
import { createFileTools, createConflictTools, createDedupeCache, parseConflicts, hashConflict } from '@agentionai/marshall-tools';
import type { ToolConfig } from '@agentionai/marshall-tools';
import { createAgent } from '../src/agent-factory.js';
import type { AgentProfile } from '../src/config.js';

const PROVIDER = (process.env.MARSHALL_LIVE_PROVIDER ?? 'openrouter') as AgentProfile['provider'];
const MODEL = process.env.MARSHALL_LIVE_MODEL ?? 'deepseek/deepseek-v4-flash-0731';
const HOST = process.env.MARSHALL_LIVE_HOST; // undefined lets the provider default apply

function loadApiKey(): string | undefined {
  if (PROVIDER !== 'openrouter') return undefined; // local providers (llamacpp/ollama) need none
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const configPath = join(homedir(), '.config', 'marshall', 'config.json');
  if (existsSync(configPath)) {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const entry = (config.providers ?? []).find((p: { provider: string }) => p.provider === 'openrouter');
    if (entry?.apiKey) return entry.apiKey;
  }
  throw new Error('No OpenRouter API key found — set OPENROUTER_API_KEY or configure ~/.config/marshall/config.json');
}

const API_KEY = loadApiKey();

// ── scenario: two mid-sized files, five independent conflicts ──────────────
//
// A harsher version of the original two-line-file scenario: enough bulk that
// a whole-file read_file actually costs tokens, and enough hunks (spread
// across two files, none adjacent) that batching resolve_conflicts into one
// call is worth something. Five conflicts, three shapes of "correct":
//
//   orders.ts
//     calculateTotal  — main fixes a real bug; feature only reformats the
//                        same (still-buggy) line.        correct: ours
//     applyDiscount   — the reverse: feature fixes the bug, main only
//                        reformats the still-buggy line. correct: theirs
//     formatReceipt   — same shape as calculateTotal, a second "ours is the
//                        real fix" case so the model can't just pick a side
//                        by position.                    correct: ours
//   config.ts
//     anchorFn        — main and feature each add an unrelated call at the
//                        same insertion point.            correct: both
//     REQUIRED_FIELDS — main and feature each add a different field to the
//                        same array position.              correct: both
//
// Grading is exact-line / substring matching against the final file
// content — independent of formatting, but not of which lines are present.

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/** Bulk that never conflicts — present verbatim in base/main/feature alike,
 *  so the file is large without adding any real hunks. */
function filler(prefix: string, blocks: number): string[] {
  const lines: string[] = [];
  for (let i = 0; i < blocks; i++) {
    lines.push(
      `function ${prefix}Helper${i}(x: number): number {`,
      `  return x * ${i + 1} + ${i};`,
      `}`,
      '',
    );
  }
  return lines;
}

/** `lines` with any line matching a key in `replacements` swapped for its value. */
function withReplacements(lines: string[], replacements: Record<string, string>): string[] {
  return lines.map((line) => (line in replacements ? replacements[line] : line));
}

const ORDERS_BASE = [
  'export const TAX_RATE = 0.08;',
  '',
  'export interface Item {',
  '  price: number;',
  '  quantity: number;',
  '}',
  '',
  ...filler('orders1', 6),
  'export function calculateTotal(items: Item[]): number {',
  '  let total = 0;',
  '  for (const item of items) {',
  '    total += item.price * item.quantity;',
  '  }',
  '  return total * TAX_RATE; // BUG: tax should be applied by the caller, not here',
  '}',
  '',
  ...filler('orders2', 6),
  'export function applyDiscount(total: number, code: string): number {',
  '  if (code === \'SAVE10\') {',
  '    return total * 0.1; // BUG: this returns the discount, not the discounted total',
  '  }',
  '  return total;',
  '}',
  '',
  ...filler('orders3', 6),
  'export function formatReceipt(lines: string[]): string {',
  '  let out = \'\';',
  '  for (let i = 0; i <= lines.length; i++) { // BUG: off-by-one, reads past the last line',
  '    out += lines[i] + \'\\n\';',
  '  }',
  '  return out;',
  '}',
  '',
  ...filler('orders4', 6),
];

const ORDERS_MAIN = withReplacements(ORDERS_BASE, {
  '  return total * TAX_RATE; // BUG: tax should be applied by the caller, not here': '  return total;',
  '    return total * 0.1; // BUG: this returns the discount, not the discounted total':
    '    return (total * 0.1); // still wrong — tax handled elsewhere now',
  '  for (let i = 0; i <= lines.length; i++) { // BUG: off-by-one, reads past the last line':
    '  for (let i = 0; i < lines.length; i++) {',
});

const ORDERS_FEATURE = withReplacements(ORDERS_BASE, {
  '  return total * TAX_RATE; // BUG: tax should be applied by the caller, not here':
    '  return (total * TAX_RATE); // reformatted',
  '    return total * 0.1; // BUG: this returns the discount, not the discounted total':
    '    return total - total * 0.1;',
  '  for (let i = 0; i <= lines.length; i++) { // BUG: off-by-one, reads past the last line':
    '  for (let i = 0; i <= lines.length; i++) { // reformatted, still off-by-one',
});

const CONFIG_BASE = [
  'export interface Config {',
  '  fields: string[];',
  '}',
  '',
  ...filler('config1', 4),
  'export function anchorFn(): void {',
  '  doSomethingCore();',
  '}',
  '',
  ...filler('config2', 4),
  'export const REQUIRED_FIELDS = [',
  '  \'id\',',
  '  \'name\',',
  '];',
  '',
  ...filler('config3', 4),
];

const CONFIG_MAIN = withReplacements(CONFIG_BASE, {
  '  doSomethingCore();': '  doSomethingCore();\n  logAudit();',
  '  \'name\',': '  \'name\',\n  \'email\',',
});

const CONFIG_FEATURE = withReplacements(CONFIG_BASE, {
  '  doSomethingCore();': '  doSomethingCore();\n  notifyMetrics();',
  '  \'name\',': '  \'name\',\n  \'phone\',',
});

function write(root: string, name: string, lines: string[]): void {
  writeFileSync(join(root, name), lines.join('\n') + '\n');
}

function makeScenarioRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'marshall-live-conflict-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);

  write(root, 'orders.ts', ORDERS_BASE);
  write(root, 'config.ts', CONFIG_BASE);
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'base']);

  git(root, ['checkout', '-q', '-b', 'feature']);
  write(root, 'orders.ts', ORDERS_FEATURE);
  write(root, 'config.ts', CONFIG_FEATURE);
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'feature: fix applyDiscount, add plugin B / phone field']);

  git(root, ['checkout', '-q', 'main']);
  write(root, 'orders.ts', ORDERS_MAIN);
  write(root, 'config.ts', CONFIG_MAIN);
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'main: fix calculateTotal/formatReceipt, add plugin A / email field']);

  try {
    git(root, ['merge', 'feature', '-q', '-m', 'merge']);
  } catch {
    // expected — merge conflicts, non-zero exit
  }
  return root;
}

interface Grade {
  markersClean: boolean;
  totalFixCorrect: boolean;
  discountFixCorrect: boolean;
  receiptFixCorrect: boolean;
  bothCallsKept: boolean;
  bothFieldsKept: boolean;
}

function hasLine(content: string, exact: string): boolean {
  return content.split('\n').some((line) => line.trim() === exact.trim());
}

function grade(root: string): Grade {
  const orders = existsSync(join(root, 'orders.ts')) ? readFileSync(join(root, 'orders.ts'), 'utf8') : '';
  const config = existsSync(join(root, 'config.ts')) ? readFileSync(join(root, 'config.ts'), 'utf8') : '';
  const markersClean = !orders.includes('<<<<<<<') && !config.includes('<<<<<<<');

  // Every other check is gated on markersClean: while a hunk is unresolved,
  // both sides' text is literally present in the file at once, so a plain
  // substring/line check can pass by accident on content that is still
  // sitting inside conflict markers.
  if (!markersClean) {
    return {
      markersClean: false,
      totalFixCorrect: false,
      discountFixCorrect: false,
      receiptFixCorrect: false,
      bothCallsKept: false,
      bothFieldsKept: false,
    };
  }

  const totalFixCorrect = hasLine(orders, 'return total;')
    && !orders.includes('total * TAX_RATE');
  const discountFixCorrect = hasLine(orders, 'return total - total * 0.1;')
    && !hasLine(orders, 'return total * 0.1;') && !hasLine(orders, 'return (total * 0.1);');
  const receiptFixCorrect = hasLine(orders, 'for (let i = 0; i < lines.length; i++) {')
    && !orders.includes('i <= lines.length');

  const bothCallsKept = config.includes('logAudit();') && config.includes('notifyMetrics();');
  const bothFieldsKept = config.includes('\'email\',') && config.includes('\'phone\',');

  return { markersClean, totalFixCorrect, discountFixCorrect, receiptFixCorrect, bothCallsKept, bothFieldsKept };
}

// ── run one condition ────────────────────────────────────────────────────

interface RunResult {
  grade: Grade;
  toolCalls: string[];
  inputTokens: number;
  outputTokens: number;
  wallMs: number;
  finalMessage: string;
}

const INSTRUCTION =
  'There are unresolved git merge conflicts in this workspace (orders.ts and config.ts). ' +
  'Resolve every conflict so the files are valid TypeScript with no conflict markers left. ' +
  'Use your judgement about which side is correct when the two sides genuinely disagree; keep ' +
  'both changes when they are independent and both belong. When you are done, reply with a one-line summary.';

const SYSTEM_PROMPT =
  'You are a coding assistant working in a git repository with unresolved merge conflicts. ' +
  'You have file tools to inspect and edit files' +
  '. Be terse — no filler.';

async function runCondition(label: string, withConflictTools: boolean): Promise<RunResult> {
  const root = makeScenarioRepo();
  const toolConfig: ToolConfig = {
    workspaceRoot: root,
    approval: async () => 'approve',
  };

  const tools: Tool<unknown>[] = [
    ...createFileTools(toolConfig, createDedupeCache()),
    ...(withConflictTools ? createConflictTools(toolConfig) : []),
  ];

  const toolCalls: string[] = [];
  for (const t of tools) {
    t.on(ToolResultEvent.RESULT, (event: InstanceType<typeof ToolResultEvent>) => {
      toolCalls.push(event.target.name);
    });
  }

  const profile: AgentProfile = {
    provider: PROVIDER,
    model: MODEL,
    ...(API_KEY ? { apiKey: API_KEY } : {}),
    ...(HOST ? { host: HOST } : {}),
  };
  const agent = await createAgent(profile, tools, new History(), {
    name: `live-test-${label}`,
    systemPrompt: SYSTEM_PROMPT,
  });

  const start = Date.now();
  const finalMessage = await agent.execute(INSTRUCTION);
  const wallMs = Date.now() - start;

  const usage = agent.lastTokenUsage;
  return {
    grade: grade(root),
    toolCalls,
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    wallMs,
    finalMessage,
  };
}

/** MARSHALL_LIVE_DRY_RUN=1 builds the scenario and prints what list_conflicts
 *  sees, with no model call — for checking the fixture itself is right. */
async function dryRun() {
  const root = makeScenarioRepo();
  console.log(`scenario at ${root}\n`);
  const [list_conflicts] = createConflictTools({ workspaceRoot: root, approval: async () => 'approve' });
  console.log(await list_conflicts.execute('a', 'b', {}, 'id'));
  console.log('\nunresolved grade (expect everything false except nothing):', grade(root));
}

/** MARSHALL_LIVE_VERIFY_GRADER=1 applies the known-correct resolution by hand
 *  (no model) and checks grade() actually reaches all-true — a check on the
 *  grader itself, not on any model. */
async function verifyGrader() {
  const root = makeScenarioRepo();
  const orders = parseConflicts(readFileSync(join(root, 'orders.ts'), 'utf8'));
  const config = parseConflicts(readFileSync(join(root, 'config.ts'), 'utf8'));

  const resolutions = [
    ...orders.map((h) => {
      if (h.oursText.includes('return total;')) return { id: hashConflict('orders.ts', h), choice: 'ours' };
      if (h.theirsText.includes('return total - total * 0.1;')) return { id: hashConflict('orders.ts', h), choice: 'theirs' };
      if (h.oursText.includes('i < lines.length')) return { id: hashConflict('orders.ts', h), choice: 'ours' };
      throw new Error(`unrecognized orders.ts hunk: ${h.oursText}`);
    }),
    ...config.map((h) => ({ id: hashConflict('config.ts', h), choice: 'both' })),
  ];

  const tools = createConflictTools({ workspaceRoot: root, approval: async () => 'approve' });
  const resolve_conflicts = tools.find((t) => t.name === 'resolve_conflicts')!;
  console.log(await resolve_conflicts.execute('a', 'b', { resolutions }, 'id'));
  console.log('\ngrade after hand-applying the correct resolution (expect everything true):', grade(root));
}

async function main() {
  if (process.env.MARSHALL_LIVE_VERIFY_GRADER) return verifyGrader();
  if (process.env.MARSHALL_LIVE_DRY_RUN) return dryRun();

  console.log(`Testing ${MODEL} via ${PROVIDER}\n`);

  const baseline = await runCondition('baseline', false);
  console.log('── baseline (read_file/edit_file/write_file only) ──');
  report(baseline);

  const withTool = await runCondition('with-tool', true);
  console.log('\n── with list_conflicts / resolve_conflict ──');
  report(withTool);

  console.log('\n── summary ──');
  console.log(`                       baseline   with-tool`);
  console.log(`markers clean          ${pad(baseline.grade.markersClean)}   ${pad(withTool.grade.markersClean)}`);
  console.log(`calculateTotal fix     ${pad(baseline.grade.totalFixCorrect)}   ${pad(withTool.grade.totalFixCorrect)}`);
  console.log(`applyDiscount fix      ${pad(baseline.grade.discountFixCorrect)}   ${pad(withTool.grade.discountFixCorrect)}`);
  console.log(`formatReceipt fix      ${pad(baseline.grade.receiptFixCorrect)}   ${pad(withTool.grade.receiptFixCorrect)}`);
  console.log(`both calls kept        ${pad(baseline.grade.bothCallsKept)}   ${pad(withTool.grade.bothCallsKept)}`);
  console.log(`both fields kept       ${pad(baseline.grade.bothFieldsKept)}   ${pad(withTool.grade.bothFieldsKept)}`);
  console.log(`tool calls             ${String(baseline.toolCalls.length).padEnd(10)} ${withTool.toolCalls.length}`);
  console.log(`input tokens           ${String(baseline.inputTokens).padEnd(10)} ${withTool.inputTokens}`);
  console.log(`output tokens          ${String(baseline.outputTokens).padEnd(10)} ${withTool.outputTokens}`);
  console.log(`wall time (ms)         ${String(baseline.wallMs).padEnd(10)} ${withTool.wallMs}`);
}

function pad(b: boolean): string {
  return (b ? 'PASS' : 'FAIL').padEnd(8);
}

function report(r: RunResult) {
  console.log(`grade: ${JSON.stringify(r.grade)}`);
  console.log(`tool calls (${r.toolCalls.length}): ${r.toolCalls.join(', ')}`);
  console.log(`tokens: ${r.inputTokens} in / ${r.outputTokens} out   wall: ${r.wallMs}ms`);
  console.log(`final message: ${r.finalMessage.slice(0, 300)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
