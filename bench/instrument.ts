// ── per-request usage, read off the wire ────────────────────────────────────
//
// The engine's own usage tally cannot answer "how big was the largest single
// prompt". `lastTokenUsage` accumulates across the steps of a tool-use loop
// (the SDK sums counts and durations when several calls are folded together),
// so a turn's `inputTokens` is the *sum* of its prompts, not the largest one —
// and `session.ts` polls it every 500ms precisely because the SDK exposes no
// per-step usage event.
//
// Marshall runs in-process here, `openai` uses `globalThis.fetch`, and the
// agents SDK sets `stream_options: { include_usage: true }`, so the last SSE
// chunk of every request carries that request's own usage. Wrapping fetch is
// the whole of the instrumentation.
//
// This exists to *corroborate* llama-journal.ts, which is the primary source —
// the journal knows how much of a prompt was recomputed versus served from the
// KV cache, which no API response reports. The probe's job is to confirm that a
// journal task belongs to this process, and to check the journal's arithmetic
// against the server's own token accounting.

export interface ApiCall {
  index: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  /** Time from sending the request to the first streamed byte. */
  ttfbMs?: number;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  /** Set when the response carried no usage block at all. */
  usageMissing?: boolean;

  /**
   * Characters generated on each channel of the response, counted off the wire.
   *
   * `completionTokens` says how much the model generated; it does not say what
   * of. These three do, and they are the whole question when the goal is to
   * generate less: reasoning and tool arguments are attacked in completely
   * different ways, and narration in a third.
   *
   * Characters rather than tokens because only the provider can tokenise, and
   * it reports one total. The ratios are what matter, and they survive the
   * conversion.
   */
  reasoningChars: number;
  contentChars: number;
  toolArgChars: number;
}

interface Probe {
  calls: () => ApiCall[];
  /** Restores the original fetch. Always call this, even on a failed run. */
  restore: () => void;
}

interface StreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      // Providers disagree on the name; llama.cpp and DeepSeek use
      // `reasoning_content`, OpenRouter passes `reasoning` through.
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{ function?: { arguments?: string; name?: string } }>;
    };
  }>;
}

/** Adds one streamed chunk's generated characters to the right channel. */
function countDelta(call: ApiCall, chunk: unknown): void {
  const delta = (chunk as StreamChunk)?.choices?.[0]?.delta;
  if (!delta) return;
  if (typeof delta.content === 'string') call.contentChars += delta.content.length;
  const reasoning = delta.reasoning_content ?? delta.reasoning;
  if (typeof reasoning === 'string') call.reasoningChars += reasoning.length;
  for (const tc of delta.tool_calls ?? []) {
    // The name is generated too, and on a run with many small calls it is not
    // a rounding error.
    call.toolArgChars += (tc.function?.arguments?.length ?? 0) + (tc.function?.name?.length ?? 0);
  }
}

function extractUsage(obj: unknown): { prompt?: number; completion?: number } | undefined {
  const usage = (obj as { usage?: Record<string, unknown> } | null)?.usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const prompt = usage.prompt_tokens;
  const completion = usage.completion_tokens;
  if (typeof prompt !== 'number' && typeof completion !== 'number') return undefined;
  return {
    prompt: typeof prompt === 'number' ? prompt : undefined,
    completion: typeof completion === 'number' ? completion : undefined,
  };
}

/**
 * Wraps `globalThis.fetch` to record one row per provider request.
 *
 * The response body is `tee()`d rather than buffered and replayed: the caller
 * gets its branch immediately and streams at full speed, while the probe drains
 * the other branch in the background. Buffering here would serialise the whole
 * response before the agent saw a single token, which would corrupt exactly the
 * timing this run is trying to measure.
 */
export function installFetchProbe(): Probe {
  const original = globalThis.fetch;
  const calls: ApiCall[] = [];
  let index = 0;

  globalThis.fetch = async function probedFetch(input: RequestInfo | URL, init?: RequestInit) {
    const started = Date.now();
    const call: ApiCall = {
      index: index++,
      startedAt: new Date(started).toISOString(),
      endedAt: '',
      durationMs: 0,
      reasoningChars: 0,
      contentChars: 0,
      toolArgChars: 0,
    };
    calls.push(call);

    // The request body is the only place the model id appears; reading it is
    // best-effort because it may be a stream or already consumed.
    try {
      if (typeof init?.body === 'string') {
        const parsed = JSON.parse(init.body) as { model?: string };
        if (typeof parsed.model === 'string') call.model = parsed.model;
      }
    } catch { /* not JSON, or not ours — the model id is a nicety */ }

    const response = await original(input, init);
    const finish = (usage?: { prompt?: number; completion?: number }) => {
      const ended = Date.now();
      call.endedAt = new Date(ended).toISOString();
      call.durationMs = ended - started;
      if (usage) {
        call.promptTokens = usage.prompt;
        call.completionTokens = usage.completion;
      } else {
        call.usageMissing = true;
      }
    };

    if (!response.body) {
      finish();
      return response;
    }

    const [toCaller, toProbe] = response.body.tee();

    void (async () => {
      const reader = toProbe.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let usage: { prompt?: number; completion?: number } | undefined;
      let sawFirstByte = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!sawFirstByte) {
            sawFirstByte = true;
            call.ttfbMs = Date.now() - started;
          }
          buffer += decoder.decode(value, { stream: true });
          // Keep only the tail across iterations: a long response is megabytes
          // of deltas and the usage block is always in the final chunk, so
          // retaining the whole thing would grow memory for nothing.
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
              const chunk = JSON.parse(payload);
              const found = extractUsage(chunk);
              if (found) usage = found;
              countDelta(call, chunk);
            } catch { /* a partial or non-JSON data line */ }
          }
        }
        // A non-streamed response is a single JSON document, not SSE, so it
        // never matched a `data:` line above.
        if (!usage && buffer.trim().startsWith('{')) {
          try { usage = extractUsage(JSON.parse(buffer)); } catch { /* truncated */ }
        }
      } catch { /* the caller aborted, or the stream broke — record what we have */ }
      finish(usage);
    })();

    return new Response(toCaller, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } as typeof fetch;

  return {
    calls: () => calls,
    restore: () => { globalThis.fetch = original; },
  };
}
