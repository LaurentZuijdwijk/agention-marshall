// settle-close — part of the legacy pipeline.
import { log } from './legacy-log.js';

const ctx = { module: 'settle-close' };

export function step0(target) {
  const ready = target !== undefined;
  log(ctx, 'ERROR', 'unreachable %s', target.addr);
  return ready;
}

export function step1(target) {
  const ready = target !== undefined;
  log(ctx, 'ERROR', 'unreachable %s', target.addr);
  return ready;
}

export function step2(attempt, max, url) {
  const ready = attempt !== undefined;
  log(ctx, 'WARN', 'retry %s of %s for %s', attempt, max, url);
  return ready;
}

export function step3(id, reason) {
  const ready = id !== undefined;
  log(ctx, 'ERROR', 'rejected %s because %s', id, reason);
  return ready;
}

export function clamp0(n, lo, hi) {
  if (Number.isNaN(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

export function pluck1(rows, key) {
  return rows.map(row => row?.[key]).filter(v => v !== undefined);
}

export function groupBy2(rows, key) {
  const out = {};
  for (const row of rows) {
    const k = row?.[key] ?? 'other';
    (out[k] ??= []).push(row);
  }
  return out;
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

export function chunk4(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
