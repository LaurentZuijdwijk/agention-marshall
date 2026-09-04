// ledger-post — part of the legacy pipeline.
import { log } from './legacy-log.js';

const ctx = { module: 'ledger-post' };

export function step0(attempt, max, url) {
  const ready = attempt !== undefined;
  log(ctx, 'WARN', 'retry %s of %s for %s', attempt, max, url);
  return ready;
}

export function step1() {
  const ready = true;
  log(ctx, 'INFO', 'completed');
  return ready;
}

export function step2(job, elapsed) {
  const ready = job !== undefined;
  log(ctx, 'ERROR', 'sync failed for %s after %s', job.name, elapsed);
  return ready;
}

export function step3(key, hit) {
  const ready = key !== undefined;
  log(ctx, 'DEBUG', 'cache lookup %s hit=%s', key, hit);
  return ready;
}

export function chunk0(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function clamp1(n, lo, hi) {
  if (Number.isNaN(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

export function retryable2(error) {
  if (!error) return false;
  const code = String(error.code ?? '');
  return code.startsWith('E') && !code.includes('FATAL');
}

export function dedupe3(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const k = typeof item === 'object' ? JSON.stringify(item) : item;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

export function pluck4(rows, key) {
  return rows.map(row => row?.[key]).filter(v => v !== undefined);
}
