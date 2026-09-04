// ── reading llama-server's own slot logs ────────────────────────────────────
//
// The OpenAI-compatible `usage` block tells you how big a prompt was. It does
// not tell you how much of that prompt the server actually had to *compute* —
// and with llama.cpp's KV prefix cache those are wildly different numbers. A
// 48k-token prompt whose prefix is unchanged costs ~28 tokens of prompt eval.
//
// llama-server logs both, per request, along with generation rate samples and
// a `truncated` flag. This parses them out of the journal.
//
// Worked example of one request, verified against its neighbours:
//
//   slot get_availabl: id 3 | task -1    | ... f_sim_best = 0.999 ...
//   slot launch_slot_: id 3 | task 36933 | processing task, is_child = 0
//   slot print_timing: id 3 | task 36933 | prompt eval time = 192.34 ms /  28 tokens (145.58 t/s)
//   slot print_timing: id 3 | task 36933 |        eval time = 3777.29 ms / 201 tokens ( 52.95 t/s)
//   slot      release: id 3 | task 36933 | stop processing: n_tokens = 48345, truncated = 0
//
// `n_tokens` at release is the slot's occupancy *after* the response, so the
// prompt is `n_tokens - eval + 1`. The `+ 1` is not a fudge: checked against
// the API's own `usage.prompt_tokens` on every request of a six-request run,
// `n_tokens - eval` came out exactly one low every single time, and adding it
// back makes two other things fall into place that were previously off — the
// first request on a cold slot reuses exactly 0 tokens rather than -1, and a
// pure append reuses exactly what the previous request left in the slot rather
// than one short of it.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface LlamaRequest {
  taskId: number;
  slotId: number;
  /** ISO timestamp of the `launch_slot_` line. */
  startedAt: string;
  /** ISO timestamp of the `release` line, when the request got that far. */
  endedAt?: string;

  /**
   * Prompt size for this request: `n_tokens` at release, minus what was
   * generated, plus one — see the note at the top of this file for why the
   * `+ 1` is there and how it was checked.
   */
  contextTokens?: number;
  /** Prompt tokens the server actually had to compute — the rest came from the KV cache. */
  recomputedTokens?: number;
  generatedTokens?: number;
  /** Slot's total context occupancy after the response. */
  nTokens?: number;

  /** Longest-common-prefix match the slot scheduler found, 0..1. */
  fSimBest?: number;
  truncated?: boolean;

  promptEvalMs?: number;
  prefillTps?: number;
  evalMs?: number;
  evalTps?: number;

  /** `tg_3s` samples — instantaneous generation rate, one per ~3s of generation. */
  tgSamples: number[];

  /** Prompt tokens served straight from the KV cache: `contextTokens - recomputedTokens`. */
  reusedPrefixTokens?: number;
  /**
   * How far this request's reused prefix fell short of everything the previous
   * request left in the slot: `prev.nTokens - reusedPrefixTokens`.
   *
   * A pure append reuses everything the previous request left in the slot and
   * scores exactly 0. Anything above that is history the client edited after
   * having already sent it — a compression pass, a rewritten tool result —
   * forcing the server to recompute from the point of divergence. That
   * recomputation is the whole cost of a history rewrite, and it is invisible
   * in the API's `usage` block.
   *
   * Divergence is not itself the cost. A client that merely *truncates* history
   * keeps the surviving prefix intact and diverges by a lot while recomputing
   * almost nothing (seen in the journal: 122 tokens diverged, 4 recomputed). A
   * client that *edits* mid-history recomputes everything after the edit point
   * (842 diverged, 7,675 recomputed, 9.7s of prefill). Read this field for what
   * changed and `recomputedTokens` for what it cost.
   *
   * Undefined for the first request on a slot, which has nothing to diverge from.
   */
  prefixDivergenceTokens?: number;
  /** Whether this request diverged from the prefix its predecessor left behind. */
  rewroteHistory?: boolean;

  /**
   * A request is complete when it has both an `eval time` line and a `release`
   * line. Cancelled requests (the client hangs up mid-generation) get a
   * `release` with `n_tokens` but no timings at all, so `contextTokens` cannot
   * be derived for them and they must not be averaged in as if it could.
   */
  complete: boolean;
}

/** `2026-08-25T23:02:42+01:00 host llama-server[123]: [46731] ... I slot <what>: ...` */
const LINE = /^(\S+)\s+\S+\s+llama-server\[\d+\]:\s+\[(\d+)\]\s+\S+\s+\w\s+slot\s+(\S+):\s+(.*)$/;

const GET_AVAIL = /^id\s+(\d+)\s+\|\s+task\s+-?\d+\s+\|.*?f_sim_best\s*=\s*([\d.]+)/;
const LAUNCH = /^id\s+(\d+)\s+\|\s+task\s+(\d+)\s+\|\s+processing task,\s+is_child\s*=\s*(\d+)/;
const N_GEN = /^id\s+(\d+)\s+\|\s+task\s+(\d+)\s+\|\s+n_gen\s*=\s*(\d+),\s*tg\s*=\s*([\d.]+)\s*t\/s,\s*tg_3s\s*=\s*([\d.]+)\s*t\/s/;
const PROMPT_EVAL = /^id\s+(\d+)\s+\|\s+task\s+(\d+)\s+\|\s+prompt eval time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens\s*\([^,]+,\s*([\d.]+)\s*tokens per second\)/;
const EVAL = /^id\s+(\d+)\s+\|\s+task\s+(\d+)\s+\|\s+eval time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens\s*\([^,]+,\s*([\d.]+)\s*tokens per second\)/;
const RELEASE = /^id\s+(\d+)\s+\|\s+task\s+(\d+)\s+\|\s+stop processing:\s+n_tokens\s*=\s*(\d+),\s*truncated\s*=\s*(\d+)/;

/** journalctl wants `YYYY-MM-DD HH:MM:SS` in local time, not an ISO string. */
function journalStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Raw journal text for a window, so a run can archive its own slice verbatim. */
export async function fetchJournal(since: Date, until: Date): Promise<string> {
  const { stdout } = await execFileAsync('journalctl', [
    '--user', '-u', 'llama-server', '--no-pager', '-o', 'short-iso',
    '--since', journalStamp(since),
    // journalctl's --until is inclusive to the second; the release line can
    // land in the same second the run ends, so give it a second of slack.
    '--until', journalStamp(new Date(until.getTime() + 1000)),
  ], { maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

/**
 * Groups journal lines into one record per provider request.
 *
 * `port` is the *child* server's port, not the router's. The router spawns one
 * llama-server per model and multiplexes them into a single journal, so
 * filtering on it is what keeps a run's numbers from being contaminated by
 * whatever else is loaded — two Ornith quants sit on different ports and would
 * otherwise be indistinguishable.
 */
export function parseJournal(text: string, port: number): LlamaRequest[] {
  const byTask = new Map<number, LlamaRequest>();
  const order: number[] = [];
  // `get_availabl` reports the prefix match under `task -1` — the task id
  // isn't assigned until the `launch_slot_` line that follows it — so it can
  // only be attached to the next launch on the same slot.
  const pendingFSim = new Map<number, number>();

  for (const line of text.split('\n')) {
    const m = LINE.exec(line);
    if (!m) continue;
    const [, stamp, linePort, what, rest] = m;
    if (Number(linePort) !== port) continue;

    if (what === 'get_availabl') {
      const g = GET_AVAIL.exec(rest);
      if (g) pendingFSim.set(Number(g[1]), Number(g[2]));
      continue;
    }

    if (what === 'launch_slot_') {
      const g = LAUNCH.exec(rest);
      if (!g) continue;
      const [slotId, taskId, isChild] = [Number(g[1]), Number(g[2]), Number(g[3])];
      // Speculative-decode draft tasks are launched as children of the task
      // they're drafting for and report their own timings. Counting them would
      // double-count both requests and generated tokens.
      if (isChild !== 0) continue;
      const fSim = pendingFSim.get(slotId);
      pendingFSim.delete(slotId);
      byTask.set(taskId, { taskId, slotId, startedAt: stamp, fSimBest: fSim, tgSamples: [], complete: false });
      order.push(taskId);
      continue;
    }

    if (what === 'release') {
      const g = RELEASE.exec(rest);
      if (!g) continue;
      const req = byTask.get(Number(g[2]));
      if (!req) continue;
      req.endedAt = stamp;
      req.nTokens = Number(g[3]);
      req.truncated = g[4] !== '0';
      if (req.generatedTokens !== undefined) {
        req.contextTokens = req.nTokens - req.generatedTokens + 1;
        req.complete = true;
      }
      continue;
    }

    if (what !== 'print_timing') continue;

    const gen = N_GEN.exec(rest);
    if (gen) {
      byTask.get(Number(gen[2]))?.tgSamples.push(Number(gen[5]));
      continue;
    }

    // Order matters: `eval time =` is a substring of `prompt eval time =`, so
    // the prompt form has to be tried first or every prefill is misread as a
    // generation. There are exactly as many of one as the other in the journal,
    // which is the check that this pairing is right.
    const pe = PROMPT_EVAL.exec(rest);
    if (pe) {
      const req = byTask.get(Number(pe[2]));
      if (req) {
        req.promptEvalMs = Number(pe[3]);
        req.recomputedTokens = Number(pe[4]);
        req.prefillTps = Number(pe[5]);
      }
      continue;
    }

    const ev = EVAL.exec(rest);
    if (ev) {
      const req = byTask.get(Number(ev[2]));
      if (req) {
        req.evalMs = Number(ev[3]);
        req.generatedTokens = Number(ev[4]);
        req.evalTps = Number(ev[5]);
      }
    }
  }

  const requests = order.map(id => byTask.get(id)!).filter(Boolean);
  return derivePrefixReuse(requests);
}

/**
 * Fills in `reusedPrefixTokens` / `prefixDivergenceTokens` by comparing each
 * request against the previous one on the same slot.
 *
 * Verified against a real divergence in the journal: task 18392 recomputed
 * 7,675 tokens of a 29,453-token prompt, so it reused 21,778 — where the
 * previous request had left 22,619 in the slot. The 841-token difference is
 * history the client rewrote, and it is what turned a ~28-token prefill into a
 * 9.7-second one.
 */
function derivePrefixReuse(requests: LlamaRequest[]): LlamaRequest[] {
  const lastBySlot = new Map<number, LlamaRequest>();
  for (const req of requests) {
    if (!req.complete) {
      // An incomplete request still occupies the slot, and the next request
      // diverges from whatever it left behind. Dropping it from the chain
      // would misattribute that to the following request as a rewrite.
      if (req.nTokens !== undefined) lastBySlot.set(req.slotId, req);
      continue;
    }
    req.reusedPrefixTokens = req.contextTokens! - req.recomputedTokens!;
    const prev = lastBySlot.get(req.slotId);
    if (prev?.nTokens !== undefined) {
      const divergence = Math.max(0, prev.nTokens - req.reusedPrefixTokens);
      req.prefixDivergenceTokens = divergence;
      req.rewroteHistory = divergence > 0;
    }
    lastBySlot.set(req.slotId, req);
  }
  return requests;
}

export async function collectRequests(since: Date, until: Date, port: number): Promise<LlamaRequest[]> {
  return parseJournal(await fetchJournal(since, until), port);
}

/**
 * Which child port is serving a model, read from the router's own proxy log.
 * Hardcoding it would silently produce an empty result set the next time the
 * router restarts and reassigns ports.
 */
export async function findPortForModel(model: string, since: Date): Promise<number | undefined> {
  const { stdout } = await execFileAsync('journalctl', [
    '--user', '-u', 'llama-server', '--no-pager', '-o', 'short-iso', '--since', journalStamp(since),
  ], { maxBuffer: 256 * 1024 * 1024 });
  let port: number | undefined;
  const re = /proxying request to model (\S+) on port (\d+)/;
  for (const line of stdout.split('\n')) {
    const m = re.exec(line);
    if (m && m[1] === model) port = Number(m[2]); // last wins — the current one
  }
  return port;
}
