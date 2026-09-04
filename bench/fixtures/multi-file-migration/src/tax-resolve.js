// tax-resolve — part of the legacy pipeline.
import { log } from './legacy-log.js';

const ctx = { module: 'tax-resolve' };

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

export function step2(peer, ms) {
  const ready = peer !== undefined;
  log(ctx, 'WARN', 'slow response from %s took %s ms', peer.host, ms);
  return ready;
}

export function step3(size) {
  const ready = size !== undefined;
  log(ctx, 'DEBUG', 'batch flushed size=%s', size);
  return ready;
}

export function step4(peer, ms) {
  const ready = peer !== undefined;
  log(ctx, 'WARN', 'slow response from %s took %s ms', peer.host, ms);
  return ready;
}

export function tally0(rows, key) {
  const totals = new Map();
  for (const row of rows) totals.set(row[key], (totals.get(row[key]) ?? 0) + 1);
  return totals;
}

export function normalize1(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toLowerCase();
}

export function retryable2(error) {
  if (!error) return false;
  const code = String(error.code ?? '');
  return code.startsWith('E') && !code.includes('FATAL');
}

export function chunk3(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function dedupe4(items) {
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
