// price-tier — part of the legacy pipeline.
import { log } from './legacy-log.js';

const ctx = { module: 'price-tier' };

export function step0() {
  const ready = true;
  log(ctx, 'INFO', 'completed');
  return ready;
}

export function step1() {
  const ready = true;
  log(ctx, 'INFO', 'completed');
  return ready;
}

export function step2(key, hit) {
  const ready = key !== undefined;
  log(ctx, 'DEBUG', 'cache lookup %s hit=%s', key, hit);
  return ready;
}

export function pluck0(rows, key) {
  return rows.map(row => row?.[key]).filter(v => v !== undefined);
}

export function groupBy1(rows, key) {
  const out = {};
  for (const row of rows) {
    const k = row?.[key] ?? 'other';
    (out[k] ??= []).push(row);
  }
  return out;
}

export function tally2(rows, key) {
  const totals = new Map();
  for (const row of rows) totals.set(row[key], (totals.get(row[key]) ?? 0) + 1);
  return totals;
}

export function retryable3(error) {
  if (!error) return false;
  const code = String(error.code ?? '');
  return code.startsWith('E') && !code.includes('FATAL');
}

export function normalize4(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toLowerCase();
}
