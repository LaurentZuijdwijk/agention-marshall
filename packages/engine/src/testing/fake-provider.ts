// ── a fake OpenAI-compatible model server ─────────────────────────────────────
//
// The seam for integration tests is HTTP, not a mock class. `createAgent` maps
// `provider: 'llamacpp'` onto OpenAICompatibleAgent with `baseURL: host + '/v1'`,
// and that agent drives the real `openai` SDK — so pointing a profile's `host`
// at this server exercises the genuine article: request building, the tool-call
// loop, SSE parsing, usage accounting. Nothing in the engine has to know it is
// under test.
//
// Both shapes are served, because the engine uses both:
//   Session.run()        → runAgent → executeStream → stream: true  (SSE)
//   Session.plan/review  → agent.execute            → stream: false (one JSON body)

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ScriptedToolCall {
  name: string;
  arguments: Record<string, unknown>;
  /** Defaults to `call_0`, `call_1`, … Set it only when a test asserts on it. */
  id?: string;
}

/**
 * One model turn.
 *
 * A turn with `toolCalls` finishes as `tool_calls`, so the agent runs the tools
 * and comes back for the next turn — which is what makes a multi-step script
 * just an array. `text` alongside them is the prose the model wrote *before*
 * the calls.
 */
export interface ScriptedTurn {
  text?: string;
  toolCalls?: ScriptedToolCall[];
  /** Reasoning tokens. Streaming only — the non-streaming shape has nowhere to put them. */
  reasoning?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    /**
     * A subset of `completionTokens`, reported the way a reasoning model does:
     * under `completion_tokens_details`. Providers break it out precisely when
     * the thinking was theirs to hide, which is what the throughput maths keys
     * off — see `throughputOf`.
     */
    reasoningTokens?: number;
  };
  /**
   * Put the usage block on the last *content* chunk rather than on a trailing
   * choices-less one.
   *
   * Both layouts are real: the spec's `stream_options.include_usage` produces
   * the trailing chunk, and OpenRouter attaches usage to the chunk carrying
   * `finish_reason`. Reading only the first layout is why an OpenRouter turn
   * reported ↑0 ↓0 while llama.cpp reported fine.
   */
  usageOnFinalChunk?: boolean;
  /** Hold the response open this long before answering — for interrupt tests. */
  delayMs?: number;
  /**
   * Pause between streamed chunks, so the turn takes measurable wall-clock time
   * to generate. Without it a fake turn streams inside a single millisecond,
   * which is indistinguishable from a turn that produced nothing — see the
   * phase clock in usage.ts.
   */
  chunkDelayMs?: number;
}

/** What the model was actually sent, for tests that assert on the prompt. */
export interface RecordedRequest {
  model: string;
  stream: boolean;
  messages: Array<{ role: string; content: unknown; tool_call_id?: string }>;
  /** Tool names offered on this request, in order. */
  tools: string[];
  /** The whole body, for anything the fields above don't cover. */
  body: Record<string, unknown>;
  /** Request headers, lowercased by Node — for attribution and auth assertions. */
  headers: Record<string, string>;
}

export interface FakeProvider {
  /** Pass as an `AgentProfile.host` — the agent appends `/v1` itself. */
  readonly host: string;
  /** Every request served so far, oldest first. */
  readonly requests: RecordedRequest[];
  /** Queue more turns mid-test: a second `run()`, or an auto-resumed turn. */
  script(...turns: ScriptedTurn[]): void;
  /** Turns still queued — a cheap way to assert a script was fully consumed. */
  readonly pending: number;
  close(): Promise<void>;
}

/**
 * What a request gets once the script runs dry.
 *
 * A plain text turn rather than an error, on purpose: it ends the agent's loop
 * cleanly, so an under-scripted test fails on the assertion it actually cares
 * about instead of on a timeout or a provider error three layers down.
 */
const EXHAUSTED: ScriptedTurn = { text: '(fake provider: script exhausted)' };

export async function startFakeProvider(...turns: ScriptedTurn[]): Promise<FakeProvider> {
  const queue: ScriptedTurn[] = [...turns];
  const requests: RecordedRequest[] = [];

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (res.headersSent) { res.end(); return; }
      send(res, 500, { error: { message: err instanceof Error ? err.message : String(err) } });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      send(res, 404, { error: { message: `no route for ${req.method} ${req.url}` } });
      return;
    }

    const body = JSON.parse(await readBody(req)) as Record<string, any>;
    const stream = body.stream === true;
    requests.push({
      model: String(body.model ?? ''),
      stream,
      messages: Array.isArray(body.messages) ? body.messages : [],
      tools: Array.isArray(body.tools)
        ? body.tools.map((t: any) => String(t?.function?.name ?? ''))
        : [],
      body,
      headers: flattenHeaders(req.headers),
    });

    const turn = queue.shift() ?? EXHAUSTED;
    if (turn.delayMs) await new Promise(resolve => setTimeout(resolve, turn.delayMs));

    if (stream) await streamTurn(res, turn, String(body.model ?? 'fake'));
    else send(res, 200, completion(turn, String(body.model ?? 'fake')));
  }

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    host: `http://127.0.0.1:${port}`,
    requests,
    script: (...more: ScriptedTurn[]) => { queue.push(...more); },
    get pending() { return queue.length; },
    close: () => closeServer(server),
  };
}

// ── response shapes ───────────────────────────────────────────────────────────

function toolCallId(call: ScriptedToolCall, index: number): string {
  return call.id ?? `call_${index}`;
}

function usageBlock(turn: ScriptedTurn) {
  const prompt = turn.usage?.promptTokens ?? 10;
  const completion = turn.usage?.completionTokens ?? 5;
  const reasoning = turn.usage?.reasoningTokens;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(reasoning !== undefined ? { completion_tokens_details: { reasoning_tokens: reasoning } } : {}),
  };
}

/** The `stream: false` body — one whole message. */
function completion(turn: ScriptedTurn, model: string) {
  const calls = turn.toolCalls ?? [];
  return {
    id: 'chatcmpl-fake',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    // Required (though nullable) by @openrouter/sdk's response schema — every
    // other consumer just ignores the extra field.
    system_fingerprint: null,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: turn.text ?? null,
        ...(calls.length > 0 ? {
          tool_calls: calls.map((call, i) => ({
            id: toolCallId(call, i),
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          })),
        } : {}),
      },
      // Never 'length': that path throws MaxTokensExceededError inside the agent.
      finish_reason: calls.length > 0 ? 'tool_calls' : 'stop',
    }],
    usage: usageBlock(turn),
  };
}

/**
 * The `stream: true` body — SSE.
 *
 * Text and tool-call arguments are deliberately split across several chunks:
 * accumulating those fragments is the agent's job, and a single-chunk fake
 * would never exercise it.
 */
async function streamTurn(res: ServerResponse, turn: ScriptedTurn, model: string): Promise<void> {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const created = Math.floor(Date.now() / 1000);
  const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) => {
    res.write(`data: ${JSON.stringify({
      id: 'chatcmpl-fake', object: 'chat.completion.chunk', created, model, choices, ...extra,
    })}\n\n`);
  };
  const pause = turn.chunkDelayMs
    ? () => new Promise<void>(resolve => setTimeout(resolve, turn.chunkDelayMs))
    : () => Promise.resolve();
  const delta = async (d: Record<string, unknown>) => {
    chunk([{ index: 0, delta: d, finish_reason: null }]);
    await pause();
  };

  await delta({ role: 'assistant' });
  for (const piece of split(turn.reasoning ?? '')) await delta({ reasoning: piece });
  for (const piece of split(turn.text ?? '')) await delta({ content: piece });

  const calls = turn.toolCalls ?? [];
  for (const [i, call] of calls.entries()) {
    const args = JSON.stringify(call.arguments);
    // The name arrives with the id in the opening fragment; the arguments follow
    // in pieces, which is how every real server does it.
    await delta({ tool_calls: [{ index: i, id: toolCallId(call, i), type: 'function', function: { name: call.name, arguments: '' } }] });
    for (const piece of split(args)) {
      await delta({ tool_calls: [{ index: i, function: { arguments: piece } }] });
    }
  }

  const finish = [{ index: 0, delta: {}, finish_reason: calls.length > 0 ? 'tool_calls' : 'stop' }];
  if (turn.usageOnFinalChunk) {
    chunk(finish, { usage: usageBlock(turn) });
  } else {
    chunk(finish);
    // Usage rides a choices-less final chunk, per `stream_options.include_usage`.
    chunk([], { usage: usageBlock(turn) });
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

/** Cut a string into small pieces so the client has something to reassemble. */
function split(text: string, size = 8): string[] {
  if (text === '') return [];
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += size) pieces.push(text.slice(i, i + size));
  return pieces;
}

// ── plumbing ──────────────────────────────────────────────────────────────────

/** Repeated headers keep only the last value — no caller here sends any. */
function flattenHeaders(headers: IncomingMessage['headers']): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    flat[name] = Array.isArray(value) ? value[value.length - 1] : value;
  }
  return flat;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * `server.close()` only stops new connections — the SDK's keep-alive sockets
 * would hold the process open past the test run, so they are cut explicitly.
 */
function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close(err => (err ? reject(err) : resolve()));
  });
}
