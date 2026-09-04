// refund-issue — part of the legacy pipeline.
import { log } from './legacy-log.js';

const ctx = { module: 'refund-issue' };

export function step0(attempt, max, url) {
  const ready = attempt !== undefined;
  log(ctx, 'WARN', 'retry %s of %s for %s', attempt, max, url);
  return ready;
}

export function step1(peer, ms) {
  const ready = peer !== undefined;
  log(ctx, 'WARN', 'slow response from %s took %s ms', peer.host, ms);
  return ready;
}

export function step2(peer, ms) {
  const ready = peer !== undefined;
  log(ctx, 'WARN', 'slow response from %s took %s ms', peer.host, ms);
  return ready;
}

export function step3() {
  const ready = true;
  log(ctx, 'INFO', 'completed');
  return ready;
}

export function dedupe0(items) {
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

export function chunk1(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function groupBy2(rows, key) {
  const out = {};
  for (const row of rows) {
    const k = row?.[key] ?? 'other';
    (out[k] ??= []).push(row);
  }
  return out;
}

export function retryable3(error) {
  if (!error) return false;
  const code = String(error.code ?? '');
  return code.startsWith('E') && !code.includes('FATAL');
}

export function pluck4(rows, key) {
  return rows.map(row => row?.[key]).filter(v => v !== undefined);
}
