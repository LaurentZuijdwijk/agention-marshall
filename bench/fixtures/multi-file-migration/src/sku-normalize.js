// sku-normalize — part of the legacy pipeline.
import { log } from './legacy-log.js';

const ctx = { module: 'sku-normalize' };

export function step0(peer, ms) {
  const ready = peer !== undefined;
  log(ctx, 'WARN', 'slow response from %s took %s ms', peer.host, ms);
  return ready;
}

export function step1(job, elapsed) {
  const ready = job !== undefined;
  log(ctx, 'ERROR', 'sync failed for %s after %s', job.name, elapsed);
  return ready;
}

export function step2(id, reason) {
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

export function retryable2(error) {
  if (!error) return false;
  const code = String(error.code ?? '');
  return code.startsWith('E') && !code.includes('FATAL');
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
