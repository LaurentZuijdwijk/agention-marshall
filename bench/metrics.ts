// ── turning raw per-request records into the numbers the report quotes ──────

import type { LlamaRequest } from './llama-journal.js';
import type { ApiCall } from './instrument.js';

export interface RunMetrics {
  /** Provider requests the journal saw for this run. */
  apiCalls: number;
  /** Σ prompt tokens across every request — what the model was made to read. */
  tokensSent?: number;
  /** Σ generated tokens. */
  tokensReceived?: number;
  /** Largest single prompt. The question "does context blow up" is about this. */
  peakContextTokens?: number;
  /** Σ prompt tokens the server actually had to compute; the rest came from cache. */
  tokensRecomputed?: number;
  /** `tokensRecomputed / tokensSent` — 0.01 means 99% of the reading was free. */
  recomputedShare?: number;
  /** Did the server ever have to drop context to fit the window. */
  anyTruncated?: boolean;
  /** Requests that edited history they had already sent — see `prefixDivergenceTokens`. */
  historyRewrites?: number;
  minFSim?: number;

  /** Generation rate, from pooled `tg_3s` samples. */
  tgMedian?: number;
  tgP10?: number;
  tgMin?: number;
  tgMax?: number;
  tgSampleCount?: number;

  prefillTokensMedian?: number;
  prefillTokensMax?: number;

  /** Output tokens over total wall-clock — the agent's rate, not the model's. */
  effectiveTps?: number;
}

export function median(nums: number[]): number | undefined {
  return percentile(nums, 0.5);
}

export function percentile(nums: number[], p: number): number | undefined {
  if (!nums.length) return undefined;
  const sorted = [...nums].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function sum(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0);
}

/**
 * Generation-rate samples for a run.
 *
 * `tg_3s` is the instantaneous rate over the trailing three seconds; `tg` on
 * the same line is a cumulative average, which flattens exactly the variation
 * worth seeing. Responses shorter than one sampling interval emit no `tg_3s`
 * line at all, so their per-request `eval` rate stands in — otherwise every
 * short response silently drops out of the distribution and the histogram
 * describes only the long ones.
 */
export function tgSamples(requests: LlamaRequest[]): { value: number; sampled: boolean }[] {
  const out: { value: number; sampled: boolean }[] = [];
  for (const req of requests) {
    if (req.tgSamples.length) {
      for (const v of req.tgSamples) out.push({ value: v, sampled: true });
    } else if (req.evalTps !== undefined && req.generatedTokens) {
      out.push({ value: req.evalTps, sampled: false });
    }
  }
  return out;
}

export function summarize(
  requests: LlamaRequest[],
  _calls: ApiCall[],
  durationMs: number,
): RunMetrics {
  const complete = requests.filter(r => r.complete);
  if (!complete.length) return { apiCalls: requests.length };

  const contexts = complete.map(r => r.contextTokens!);
  const generated = complete.map(r => r.generatedTokens!);
  const recomputed = complete.map(r => r.recomputedTokens!);
  const tg = tgSamples(complete).map(s => s.value);
  const fSims = complete.map(r => r.fSimBest).filter((v): v is number => v !== undefined);

  const tokensSent = sum(contexts);
  const tokensRecomputed = sum(recomputed);
  const tokensReceived = sum(generated);

  return {
    apiCalls: requests.length,
    tokensSent,
    tokensReceived,
    peakContextTokens: Math.max(...contexts),
    tokensRecomputed,
    recomputedShare: tokensSent ? tokensRecomputed / tokensSent : undefined,
    anyTruncated: complete.some(r => r.truncated),
    historyRewrites: complete.filter(r => r.rewroteHistory).length,
    minFSim: fSims.length ? Math.min(...fSims) : undefined,

    tgMedian: median(tg),
    tgP10: percentile(tg, 0.1),
    tgMin: tg.length ? Math.min(...tg) : undefined,
    tgMax: tg.length ? Math.max(...tg) : undefined,
    tgSampleCount: tg.length,

    prefillTokensMedian: median(recomputed),
    prefillTokensMax: Math.max(...recomputed),

    effectiveTps: durationMs > 0 ? tokensReceived / (durationMs / 1000) : undefined,
  };
}

function csvCell(v: unknown): string {
  if (v === undefined || v === null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map(c => csvCell(row[c])).join(','));
  return lines.join('\n') + '\n';
}

export const REQUEST_COLUMNS = [
  'taskId', 'slotId', 'startedAt', 'endedAt', 'contextTokens', 'recomputedTokens',
  'reusedPrefixTokens', 'prefixDivergenceTokens', 'rewroteHistory', 'generatedTokens',
  'nTokens', 'fSimBest', 'truncated', 'promptEvalMs', 'prefillTps', 'evalMs', 'evalTps',
  'complete',
];
