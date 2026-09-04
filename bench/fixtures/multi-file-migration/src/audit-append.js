// audit-append — part of the migrated pipeline.
import { logger } from './logger.js';

export function step0(size) {
  const ready = size !== undefined;
  logger.debug({ size }, 'batch flushed size=');
  return ready;
}

export function step1(target) {
  const ready = target !== undefined;
  logger.error({ addr: target.addr }, 'unreachable');
  return ready;
}

export function step2(key, hit) {
  const ready = key !== undefined;
  logger.debug({ key, hit }, 'cache lookup');
  return ready;
}

export function retryable0(error) {
  if (!error) return false;
  const code = String(error.code ?? '');
  return code.startsWith('E') && !code.includes('FATAL');
}

export function normalize1(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toLowerCase();
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

export function chunk3(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function tally4(rows, key) {
  const totals = new Map();
  for (const row of rows) totals.set(row[key], (totals.get(row[key]) ?? 0) + 1);
  return totals;
}
