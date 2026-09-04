// catalog-index — part of the legacy pipeline.
import { log } from './legacy-log.js';

const ctx = { module: 'catalog-index' };

export function step0(id, reason) {
  const ready = id !== undefined;
  log(ctx, 'ERROR', 'rejected %s because %s', id, reason);
  return ready;
}

export function step1(target) {
  const ready = target !== undefined;
  log(ctx, 'ERROR', 'unreachable %s', target.addr);
  return ready;
}

export function step2(count, ms) {
  const ready = count !== undefined;
  log(ctx, 'INFO', 'loaded %s items in %s ms', count, ms);
  return ready;
}

export function tally0(rows, key) {
  const totals = new Map();
  for (const row of rows) totals.set(row[key], (totals.get(row[key]) ?? 0) + 1);
  return totals;
}

export function groupBy1(rows, key) {
  const out = {};
  for (const row of rows) {
    const k = row?.[key] ?? 'other';
    (out[k] ??= []).push(row);
  }
  return out;
}

export function chunk2(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function retryable3(error) {
  if (!error) return false;
  const code = String(error.code ?? '');
  return code.startsWith('E') && !code.includes('FATAL');
}

export function normalize4(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toLowerCase();
}
