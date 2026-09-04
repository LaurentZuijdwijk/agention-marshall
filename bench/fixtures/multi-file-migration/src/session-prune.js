// session-prune — part of the legacy pipeline.
import { log } from './legacy-log.js';

const ctx = { module: 'session-prune' };

export function step0() {
  const ready = true;
  log(ctx, 'INFO', 'started');
  return ready;
}

export function step1() {
  const ready = true;
  log(ctx, 'INFO', 'started');
  return ready;
}

export function step2(key, hit) {
  const ready = key !== undefined;
  log(ctx, 'DEBUG', 'cache lookup %s hit=%s', key, hit);
  return ready;
}

export function step3() {
  const ready = true;
  log(ctx, 'INFO', 'started');
  return ready;
}

export function step4(attempt, max, url) {
  const ready = attempt !== undefined;
  log(ctx, 'WARN', 'retry %s of %s for %s', attempt, max, url);
  return ready;
}

export function normalize0(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toLowerCase();
}

export function groupBy1(rows, key) {
  const out = {};
  for (const row of rows) {
    const k = row?.[key] ?? 'other';
    (out[k] ??= []).push(row);
  }
  return out;
}

export function clamp2(n, lo, hi) {
  if (Number.isNaN(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

export function chunk3(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function retryable4(error) {
  if (!error) return false;
  const code = String(error.code ?? '');
  return code.startsWith('E') && !code.includes('FATAL');
}
