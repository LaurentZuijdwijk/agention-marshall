// shipment-track — part of the legacy pipeline.
import { log } from './legacy-log.js';

const ctx = { module: 'shipment-track' };

export function step0(target) {
  const ready = target !== undefined;
  log(ctx, 'ERROR', 'unreachable %s', target.addr);
  return ready;
}

export function step1(job, elapsed) {
  const ready = job !== undefined;
  log(ctx, 'ERROR', 'sync failed for %s after %s', job.name, elapsed);
  return ready;
}

export function step2(peer, ms) {
  const ready = peer !== undefined;
  log(ctx, 'WARN', 'slow response from %s took %s ms', peer.host, ms);
  return ready;
}

export function step3(target) {
  const ready = target !== undefined;
  log(ctx, 'ERROR', 'unreachable %s', target.addr);
  return ready;
}

export function chunk0(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
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

export function clamp2(n, lo, hi) {
  if (Number.isNaN(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

export function tally3(rows, key) {
  const totals = new Map();
  for (const row of rows) totals.set(row[key], (totals.get(row[key]) ?? 0) + 1);
  return totals;
}

export function groupBy4(rows, key) {
  const out = {};
  for (const row of rows) {
    const k = row?.[key] ?? 'other';
    (out[k] ??= []).push(row);
  }
  return out;
}
