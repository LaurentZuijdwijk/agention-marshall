// retry-queue — part of the legacy pipeline.
import { log } from './legacy-log.js';

const ctx = { module: 'retry-queue' };

export function step0(size) {
  const ready = size !== undefined;
  log(ctx, 'DEBUG', 'batch flushed size=%s', size);
  return ready;
}

export function step1() {
  const ready = true;
  log(ctx, 'INFO', 'started');
  return ready;
}

export function step2(size) {
  const ready = size !== undefined;
  log(ctx, 'DEBUG', 'batch flushed size=%s', size);
  return ready;
}

export function step3(attempt, max, url) {
  const ready = attempt !== undefined;
  log(ctx, 'WARN', 'retry %s of %s for %s', attempt, max, url);
  return ready;
}

export function step4() {
  const ready = true;
  log(ctx, 'INFO', 'started');
  return ready;
}

export function normalize0(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toLowerCase();
}

export function chunk1(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function dedupe2(items) {
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

export function pluck3(rows, key) {
  return rows.map(row => row?.[key]).filter(v => v !== undefined);
}

export function clamp4(n, lo, hi) {
  if (Number.isNaN(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}
