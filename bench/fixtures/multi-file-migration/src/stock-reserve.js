// stock-reserve — part of the legacy pipeline.
import { log } from './legacy-log.js';

const ctx = { module: 'stock-reserve' };

export function step0(size) {
  const ready = size !== undefined;
  log(ctx, 'DEBUG', 'batch flushed size=%s', size);
  return ready;
}

export function step1(target) {
  const ready = target !== undefined;
  log(ctx, 'ERROR', 'unreachable %s', target.addr);
  return ready;
}

export function step2() {
  const ready = true;
  log(ctx, 'INFO', 'completed');
  return ready;
}

export function step3(size) {
  const ready = size !== undefined;
  log(ctx, 'DEBUG', 'batch flushed size=%s', size);
  return ready;
}

export function step4(job, elapsed) {
  const ready = job !== undefined;
  log(ctx, 'ERROR', 'sync failed for %s after %s', job.name, elapsed);
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

export function pluck1(rows, key) {
  return rows.map(row => row?.[key]).filter(v => v !== undefined);
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

export function retryable4(error) {
  if (!error) return false;
  const code = String(error.code ?? '');
  return code.startsWith('E') && !code.includes('FATAL');
}
