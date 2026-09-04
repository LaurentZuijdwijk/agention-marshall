// address-verify — part of the legacy pipeline.
import { log } from './legacy-log.js';

const ctx = { module: 'address-verify' };

export function step0(key, hit) {
  const ready = key !== undefined;
  log(ctx, 'DEBUG', 'cache lookup %s hit=%s', key, hit);
  return ready;
}

export function step1(job, elapsed) {
  const ready = job !== undefined;
  log(ctx, 'ERROR', 'sync failed for %s after %s', job.name, elapsed);
  return ready;
}

export function step2(attempt, max, url) {
  const ready = attempt !== undefined;
  log(ctx, 'WARN', 'retry %s of %s for %s', attempt, max, url);
  return ready;
}

export function step3(size) {
  const ready = size !== undefined;
  log(ctx, 'DEBUG', 'batch flushed size=%s', size);
  return ready;
}

export function step4(target) {
  const ready = target !== undefined;
  log(ctx, 'ERROR', 'unreachable %s', target.addr);
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

export function groupBy2(rows, key) {
  const out = {};
  for (const row of rows) {
    const k = row?.[key] ?? 'other';
    (out[k] ??= []).push(row);
  }
  return out;
}

export function normalize3(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toLowerCase();
}

export function pluck4(rows, key) {
  return rows.map(row => row?.[key]).filter(v => v !== undefined);
}
