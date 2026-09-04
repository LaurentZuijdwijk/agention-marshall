#!/usr/bin/env node
// ── generator for the multi-file-migration fixture ──────────────────────────
//
// The task is a codebase-wide API migration: every call site of a legacy
// `log(ctx, LEVEL, template, ...args)` has to become a structured
// `logger.<level>({ fields }, message)` call. It exists to make an agent read
// and write a lot of files in one session, which is the regime the short bench
// tasks never reach.
//
// Generated rather than hand-written for two reasons: the module count is a
// parameter, so the task can be made longer without more authoring; and the
// tests are derived from the same call-site records that produce the source,
// so the expected output cannot drift from the spec the agent is given.
//
//   node scripts/build-migration-fixture.mjs --modules 30
//
// Determinism matters — a fixture that differs between runs makes two runs
// incomparable — so everything random here comes from a seeded PRNG.

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function mulberry32(seed) {
  return function next() {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DOMAINS = [
  'order-sync', 'invoice-parse', 'ledger-post', 'cart-merge', 'quote-build',
  'shipment-track', 'refund-issue', 'tax-resolve', 'catalog-index', 'price-tier',
  'stock-reserve', 'payment-capture', 'address-verify', 'coupon-apply', 'batch-split',
  'webhook-relay', 'session-prune', 'audit-append', 'retry-queue', 'rate-bucket',
  'feed-import', 'sku-normalize', 'region-route', 'currency-swap', 'label-print',
  'dispute-open', 'settle-close', 'fraud-score', 'vendor-sync', 'digest-mail',
  'token-rotate', 'quota-check', 'lease-renew', 'shard-pick', 'cache-warm',
];

/**
 * Call-site shapes.
 *
 * `lead` is the message text the migration keeps; `args` are the expressions
 * passed. An arg written as `job.name` migrates to a field called `name` — the
 * last dotted segment — which is what stops the whole migration from being one
 * regex: the field name is not always the argument text.
 */
const SHAPES = [
  { level: 'WARN', lead: 'retry', tail: '%s of %s for %s', args: ['attempt', 'max', 'url'] },
  { level: 'INFO', lead: 'loaded', tail: '%s items in %s ms', args: ['count', 'ms'] },
  { level: 'ERROR', lead: 'sync failed', tail: 'for %s after %s', args: ['job.name', 'elapsed'] },
  { level: 'DEBUG', lead: 'cache lookup', tail: '%s hit=%s', args: ['key', 'hit'] },
  { level: 'INFO', lead: 'started', tail: '', args: [] },
  { level: 'WARN', lead: 'slow response', tail: 'from %s took %s ms', args: ['peer.host', 'ms'] },
  { level: 'ERROR', lead: 'rejected', tail: '%s because %s', args: ['id', 'reason'] },
  { level: 'DEBUG', lead: 'batch flushed', tail: 'size=%s', args: ['size'] },
  { level: 'INFO', lead: 'completed', tail: '', args: [] },
  { level: 'ERROR', lead: 'unreachable', tail: '%s', args: ['target.addr'] },
];

/**
 * The message a template migrates to: everything before the first `%s`.
 *
 * Derived rather than carried alongside the template, so the fixture, the
 * tests and MIGRATION.md cannot disagree about what a given call site should
 * become. Carrying it separately is exactly how they first did disagree.
 */
function messageOf(template) {
  return template.includes('%s') ? template.slice(0, template.indexOf('%s')).trim() : template;
}

/** `job.name` -> `name`; a bare identifier is its own field name. */
function fieldName(expr) {
  return expr.includes('.') ? expr.slice(expr.lastIndexOf('.') + 1) : expr;
}

/** Distinct parameters a function needs to supply these arg expressions. */
function paramsFor(args) {
  const seen = [];
  for (const a of args) {
    const root = a.includes('.') ? a.slice(0, a.indexOf('.')) : a;
    if (!seen.includes(root)) seen.push(root);
  }
  return seen;
}

const SAMPLE = {
  attempt: '2', max: '5', url: "'https://svc.internal/v1'", count: '17', ms: '243',
  elapsed: '1180', key: "'sku:44'", hit: 'false', id: "'req-91'", reason: "'quota'",
  size: '64', job: "{ name: 'nightly' }", peer: "{ host: 'eu-2' }", target: "{ addr: '10.0.0.4' }",
};

function sampleArg(root) {
  return SAMPLE[root] ?? "'x'";
}

/** The literal a test should expect for one migrated field. */
function expectedValue(expr) {
  const root = expr.includes('.') ? expr.slice(0, expr.indexOf('.')) : expr;
  const raw = SAMPLE[root] ?? "'x'";
  if (!expr.includes('.')) return raw;
  const prop = expr.slice(expr.lastIndexOf('.') + 1);
  const m = new RegExp(`${prop}:\\s*([^,}]+)`).exec(raw);
  return m ? m[1].trim() : "'x'";
}

function templateOf(shape) {
  return shape.tail ? `${shape.lead} ${shape.tail}` : shape.lead;
}

function legacyCall(shape) {
  const args = shape.args.length ? `, ${shape.args.join(', ')}` : '';
  return `  log(ctx, '${shape.level}', '${templateOf(shape)}'${args});`;
}

function migratedCall(shape) {
  const fields = shape.args.map(a => {
    const name = fieldName(a);
    return name === a ? name : `${name}: ${a}`;
  }).join(', ');
  return `  logger.${shape.level.toLowerCase()}({ ${fields} }, '${messageOf(templateOf(shape))}');`;
}

const HELPERS = [
  index => `export function normalize${index}(value) {\n  if (value === null || value === undefined) return '';\n  return String(value).trim().toLowerCase();\n}`,
  index => `export function chunk${index}(items, size) {\n  const out = [];\n  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));\n  return out;\n}`,
  index => `export function tally${index}(rows, key) {\n  const totals = new Map();\n  for (const row of rows) totals.set(row[key], (totals.get(row[key]) ?? 0) + 1);\n  return totals;\n}`,
  index => `export function clamp${index}(n, lo, hi) {\n  if (Number.isNaN(n)) return lo;\n  return Math.min(hi, Math.max(lo, n));\n}`,
  index => `export function pluck${index}(rows, key) {\n  return rows.map(row => row?.[key]).filter(v => v !== undefined);\n}`,
  index => `export function groupBy${index}(rows, key) {\n  const out = {};\n  for (const row of rows) {\n    const k = row?.[key] ?? 'other';\n    (out[k] ??= []).push(row);\n  }\n  return out;\n}`,
  index => `export function dedupe${index}(items) {\n  const seen = new Set();\n  const out = [];\n  for (const item of items) {\n    const k = typeof item === 'object' ? JSON.stringify(item) : item;\n    if (seen.has(k)) continue;\n    seen.add(k);\n    out.push(item);\n  }\n  return out;\n}`,
  index => `export function retryable${index}(error) {\n  if (!error) return false;\n  const code = String(error.code ?? '');\n  return code.startsWith('E') && !code.includes('FATAL');\n}`,
];

/**
 * Filler that gives each module realistic bulk without any logging in it.
 *
 * Drawn without replacement: repeating the same helper twice in one file makes
 * it obvious the module is generated, and an agent that spots the pattern stops
 * reading carefully — which is the one thing this fixture cannot afford.
 */
function helpers(rand, count) {
  const pool = [...HELPERS];
  const out = [];
  for (let i = 0; i < count && pool.length; i++) {
    out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0](i));
  }
  return out;
}

function buildModule(name, rand, migrated) {
  const siteCount = 3 + Math.floor(rand() * 4); // 3..6 call sites
  const sites = [];
  for (let i = 0; i < siteCount; i++) sites.push(SHAPES[Math.floor(rand() * SHAPES.length)]);

  const importLine = migrated
    ? `import { logger } from './logger.js';`
    : `import { log } from './legacy-log.js';`;
  const ctxLine = migrated ? '' : `\nconst ctx = { module: '${name}' };\n`;

  const fns = sites.map((shape, i) => {
    const params = paramsFor(shape.args);
    const body = migrated ? migratedCall(shape) : legacyCall(shape);
    return `export function step${i}(${params.join(', ')}) {\n`
      + `  const ready = ${params.length ? `${params[0]} !== undefined` : 'true'};\n`
      + `${body}\n`
      + `  return ready;\n}`;
  });

  const filler = helpers(rand, 5);
  const source = `// ${name} — part of the ${migrated ? 'migrated' : 'legacy'} pipeline.\n`
    + `${importLine}\n${ctxLine}\n${fns.join('\n\n')}\n\n${filler.join('\n\n')}\n`;

  return { name, sites, source };
}

function buildTest(mod) {
  const cases = mod.sites.map((shape, i) => {
    const params = paramsFor(shape.args);
    const callArgs = params.map(sampleArg).join(', ');
    const fields = shape.args.map(a => `${fieldName(a)}: ${expectedValue(a)}`).join(', ');
    const message = messageOf(templateOf(shape));
    return `test('${mod.name} step${i} logs ${shape.lead}', () => {\n`
      + `  const seen = [];\n`
      + `  const off = onLog(rec => seen.push(rec));\n`
      + `  step${i}(${callArgs});\n`
      + `  off();\n`
      + `  assert.deepStrictEqual(seen, [{ level: '${shape.level.toLowerCase()}', fields: { ${fields} }, message: '${message}' }]);\n`
      + `});`;
  });
  return `import test from 'node:test';\nimport assert from 'node:assert/strict';\n`
    + `import { onLog } from '../src/logger.js';\n`
    + `import { ${mod.sites.map((_, i) => `step${i}`).join(', ')} } from '../src/${mod.name}.js';\n\n`
    + cases.join('\n\n') + '\n';
}

const LOGGER = `// The structured logger every module should be using.
//
// Records are { level, fields, message } — the fields object carries the
// values that used to be interpolated into a format string.

const sinks = new Set();

/** Subscribe to log records. Returns an unsubscribe function. */
export function onLog(fn) {
  sinks.add(fn);
  return () => sinks.delete(fn);
}

function emit(level, fields, message) {
  for (const sink of sinks) sink({ level, fields, message });
}

export const logger = {
  debug: (fields, message) => emit('debug', fields, message),
  info: (fields, message) => emit('info', fields, message),
  warn: (fields, message) => emit('warn', fields, message),
  error: (fields, message) => emit('error', fields, message),
};
`;

// Deliberately does NOT forward to logger.js. If it did, every test would pass
// against the unmigrated fixture and the task would verify nothing.
const LEGACY = `// Deprecated. Do not add new call sites; migrate existing ones to logger.js.

const history = [];

export function log(ctx, level, template, ...args) {
  let i = 0;
  const rendered = template.replace(/%s/g, () => String(args[i++]));
  history.push({ module: ctx?.module, level, rendered });
}

export function drain() {
  return history.splice(0, history.length);
}
`;

const VENDOR = `// Vendored third-party helper — DO NOT MODIFY.
//
// This file has its own unrelated \`log\` function. It is not part of the
// migration and must be left exactly as it is.

function log(scope, message) {
  return \`[\${scope}] \${message}\`;
}

export function render(scope, rows) {
  return rows.map((row, i) => log(scope, \`row \${i}: \${row}\`));
}
`;

const MIGRATION_MD = `# Logging migration

Every module under \`src/\` still calls the deprecated \`log()\` from
\`src/legacy-log.js\`. Migrate them all to the structured logger in
\`src/logger.js\`, then delete \`src/legacy-log.js\`.

## The rule

A legacy call:

\`\`\`js
log(ctx, 'WARN', 'retry %s of %s for %s', attempt, max, url);
\`\`\`

becomes:

\`\`\`js
logger.warn({ attempt, max, url }, 'retry');
\`\`\`

Specifically:

1. **Level** — the \`'WARN'\` string becomes the method name, lowercased:
   \`logger.warn(...)\`. Levels in use are DEBUG, INFO, WARN, ERROR.
2. **Message** — everything in the template *before the first \`%s\`*, trimmed.
   \`'retry %s of %s for %s'\` gives \`'retry'\`. A template with no \`%s\` is
   used whole: \`'started'\` gives \`'started'\`.
3. **Fields** — one entry per remaining argument, in order. The key is the
   argument expression, or its **last dotted segment** if it has one:
   - \`attempt\` gives \`attempt\`
   - \`job.name\` gives \`name: job.name\`
   A call with no arguments gets an empty object: \`logger.info({}, 'started')\`.
4. Replace the \`import { log } from './legacy-log.js'\` line with
   \`import { logger } from './logger.js'\`, and drop the now-unused
   \`const ctx = ...\` line.

## Out of scope

- \`src/vendor/\` is vendored third-party code with its own unrelated \`log\`
  function. Leave it exactly as it is.
- Some modules have already been migrated. Leave those alone too.

## Done when

\`node --test\` passes and \`src/legacy-log.js\` is gone.
`;

async function main() {
  const args = process.argv.slice(2);
  const moduleCount = Number(args[args.indexOf('--modules') + 1]) || 30;
  const outDir = args.includes('--out')
    ? args[args.indexOf('--out') + 1]
    : join(__dirname, '..', 'fixtures', 'multi-file-migration');

  const rand = mulberry32(20260826);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(join(outDir, 'src', 'vendor'), { recursive: true });
  await mkdir(join(outDir, 'test'), { recursive: true });

  // Two modules ship already migrated: the agent has to notice they need no
  // work, rather than applying a blanket rewrite to everything it finds.
  const preMigrated = new Set([3, 17]);

  const writes = [
    writeFile(join(outDir, 'package.json'), JSON.stringify({ name: 'migration-fixture', private: true, type: 'module' }, null, 2) + '\n'),
    writeFile(join(outDir, 'src', 'logger.js'), LOGGER),
    writeFile(join(outDir, 'src', 'legacy-log.js'), LEGACY),
    writeFile(join(outDir, 'src', 'vendor', 'table.js'), VENDOR),
    writeFile(join(outDir, 'MIGRATION.md'), MIGRATION_MD),
  ];

  for (let i = 0; i < moduleCount; i++) {
    const name = DOMAINS[i % DOMAINS.length] + (i >= DOMAINS.length ? `-${Math.floor(i / DOMAINS.length)}` : '');
    const mod = buildModule(name, rand, preMigrated.has(i));
    writes.push(writeFile(join(outDir, 'src', `${name}.js`), mod.source));
    writes.push(writeFile(join(outDir, 'test', `${name}.test.js`), buildTest(mod)));
  }

  await Promise.all(writes);
  console.log(`wrote ${moduleCount} modules to ${outDir} (${preMigrated.size} already migrated, 1 vendor decoy)`);
}

main().catch(err => { console.error(err); process.exit(1); });
