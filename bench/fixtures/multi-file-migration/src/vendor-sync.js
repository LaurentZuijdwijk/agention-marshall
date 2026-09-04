// vendor-sync — part of the legacy pipeline.
import { log } from './legacy-log.js';

const ctx = { module: 'vendor-sync' };

export function step0(id, reason) {
  const ready = id !== undefined;
  log(ctx, 'ERROR', 'rejected %s because %s', id, reason);
  return ready;
}

export function step1(key, hit) {
  const ready = key !== undefined;
  log(ctx, 'DEBUG', 'cache lookup %s hit=%s', key, hit);
  return ready;
}

export function step2(attempt, max, url) {
  const ready = attempt !== undefined;
  log(ctx, 'WARN', 'retry %s of %s for %s', attempt, max, url);
  return ready;
}

export function step3() {
  const ready = true;
  log(ctx, 'INFO', 'completed');
  return ready;
}

export function step4() {
  const ready = true;
  log(ctx, 'INFO', 'completed');
  return ready;
}

export function step5(attempt, max, url) {
  const ready = attempt !== undefined;
  log(ctx, 'WARN', 'retry %s of %s for %s', attempt, max, url);
  return ready;
}

export function pluck0(rows, key) {
  return rows.map(row => row?.[key]).filter(v => v !== undefined);
}

export function tally1(rows, key) {
  const totals = new Map();
  for (const row of rows) totals.set(row[key], (totals.get(row[key]) ?? 0) + 1);
  return totals;
}

export function chunk2(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function groupBy3(rows, key) {
  const out = {};
  for (const row of rows) {
    const k = row?.[key] ?? 'other';
    (out[k] ??= []).push(row);
  }
  return out;
}

export function retryable4(error) {
  if (!error) return false;
  const code = String(error.code ?? '');
  return code.startsWith('E') && !code.includes('FATAL');
}
