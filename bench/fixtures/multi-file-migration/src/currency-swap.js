// currency-swap — part of the legacy pipeline.
import { log } from './legacy-log.js';

const ctx = { module: 'currency-swap' };

export function step0() {
  const ready = true;
  log(ctx, 'INFO', 'started');
  return ready;
}

export function step1(size) {
  const ready = size !== undefined;
  log(ctx, 'DEBUG', 'batch flushed size=%s', size);
  return ready;
}

export function step2(job, elapsed) {
  const ready = job !== undefined;
  log(ctx, 'ERROR', 'sync failed for %s after %s', job.name, elapsed);
  return ready;
}

export function clamp0(n, lo, hi) {
  if (Number.isNaN(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

export function pluck1(rows, key) {
  return rows.map(row => row?.[key]).filter(v => v !== undefined);
}

export function normalize2(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toLowerCase();
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

export function groupBy4(rows, key) {
  const out = {};
  for (const row of rows) {
    const k = row?.[key] ?? 'other';
    (out[k] ??= []).push(row);
  }
  return out;
}
