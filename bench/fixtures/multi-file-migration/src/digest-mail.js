// digest-mail — part of the legacy pipeline.
import { log } from './legacy-log.js';

const ctx = { module: 'digest-mail' };

export function step0(id, reason) {
  const ready = id !== undefined;
  log(ctx, 'ERROR', 'rejected %s because %s', id, reason);
  return ready;
}

export function step1(job, elapsed) {
  const ready = job !== undefined;
  log(ctx, 'ERROR', 'sync failed for %s after %s', job.name, elapsed);
  return ready;
}

export function step2(count, ms) {
  const ready = count !== undefined;
  log(ctx, 'INFO', 'loaded %s items in %s ms', count, ms);
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

export function groupBy3(rows, key) {
  const out = {};
  for (const row of rows) {
    const k = row?.[key] ?? 'other';
    (out[k] ??= []).push(row);
  }
  return out;
}

export function pluck4(rows, key) {
  return rows.map(row => row?.[key]).filter(v => v !== undefined);
}
