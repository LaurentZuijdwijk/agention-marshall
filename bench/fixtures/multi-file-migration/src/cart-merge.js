// cart-merge — part of the migrated pipeline.
import { logger } from './logger.js';

export function step0(count, ms) {
  const ready = count !== undefined;
  logger.info({ count, ms }, 'loaded');
  return ready;
}

export function step1(size) {
  const ready = size !== undefined;
  logger.debug({ size }, 'batch flushed size=');
  return ready;
}

export function step2(count, ms) {
  const ready = count !== undefined;
  logger.info({ count, ms }, 'loaded');
  return ready;
}

export function step3(id, reason) {
  const ready = id !== undefined;
  logger.error({ id, reason }, 'rejected');
  return ready;
}

export function pluck0(rows, key) {
  return rows.map(row => row?.[key]).filter(v => v !== undefined);
}

export function tally1(rows, key) {
  const totals = new Map();
  for (const row of rows) totals.set(row[key], (totals.get(row[key]) ?? 0) + 1);
  return totals;
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

export function retryable4(error) {
  if (!error) return false;
  const code = String(error.code ?? '');
  return code.startsWith('E') && !code.includes('FATAL');
}
