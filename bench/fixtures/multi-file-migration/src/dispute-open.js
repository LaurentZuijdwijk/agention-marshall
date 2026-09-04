// dispute-open — part of the legacy pipeline.
import { log } from './legacy-log.js';

const ctx = { module: 'dispute-open' };

export function step0() {
  const ready = true;
  log(ctx, 'INFO', 'started');
  return ready;
}

export function step1(count, ms) {
  const ready = count !== undefined;
  log(ctx, 'INFO', 'loaded %s items in %s ms', count, ms);
  return ready;
}

export function step2(id, reason) {
  const ready = id !== undefined;
  log(ctx, 'ERROR', 'rejected %s because %s', id, reason);
  return ready;
}

export function step3(count, ms) {
  const ready = count !== undefined;
  log(ctx, 'INFO', 'loaded %s items in %s ms', count, ms);
  return ready;
}

export function step4(size) {
  const ready = size !== undefined;
  log(ctx, 'DEBUG', 'batch flushed size=%s', size);
  return ready;
}

export function tally0(rows, key) {
  const totals = new Map();
  for (const row of rows) totals.set(row[key], (totals.get(row[key]) ?? 0) + 1);
  return totals;
}

export function dedupe1(items) {
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

export function normalize2(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toLowerCase();
}

export function groupBy3(rows, key) {
  const out = {};
  for (const row of rows) {
    const k = row?.[key] ?? 'other';
    (out[k] ??= []).push(row);
  }
  return out;
}

export function clamp4(n, lo, hi) {
  if (Number.isNaN(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}
