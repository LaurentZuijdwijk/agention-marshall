import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '@agentionai/marshall-engine';
import type { EngineConfig, ClientInterface, OutputEvent } from '@agentionai/marshall-engine';

const MODEL = 'unsloth/Qwen3.8-Flash-Next-GGUF:IQ4_XS';
const HOST = 'http://127.0.0.1:8080';

// Wire-level capture: tee every SSE chunk so we can see the RAW tool-call
// argument stream character by character, and the real finish_reason —
// independent of whatever the SDK decides to do with it.
const rawChunks: string[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const res = await originalFetch(input, init);
  if (!res.body) return res;
  const [toCaller, toLog] = res.body.tee();
  void (async () => {
    const reader = toLog.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        rawChunks.push(decoder.decode(value, { stream: true }));
      }
    } catch (err) {
      rawChunks.push(`\n[[wire capture ended: ${(err as Error).message}]]\n`);
    }
  })();
  return new Response(toCaller, { status: res.status, statusText: res.statusText, headers: res.headers });
};

const workspaceDir = await mkdtemp(join(tmpdir(), 'diag-trunc-'));
console.log('workspace:', workspaceDir);

const toolCalls: { name: string; argsPreview: string }[] = [];
const allEvents: string[] = [];
const reasoningEvents: string[] = [];
const client: ClientInterface = {
  onOutput(e: OutputEvent) {
    if (e.type === 'token') allEvents.push(e.text);
    if (e.type === 'reasoning') reasoningEvents.push(e.text);
    if (e.type === 'error') console.log('ERROR EVENT:', e.message);
    if (e.type === 'tool-call') {
      const argStr = JSON.stringify(e.input);
      toolCalls.push({ name: e.toolName, argsPreview: argStr.length > 200 ? argStr.slice(0, 200) + `...[${argStr.length} chars total]` : argStr });
      console.log(`TOOL_CALL ${e.toolName}  args=${argStr.length} chars`);
    }
    if (e.type === 'response') console.log('RESPONSE:', e.text.slice(0, 300));
  },
  async requestApproval() { return 'approve'; },
};

const engineConfig: EngineConfig = {
  agent: { provider: 'llamacpp', model: MODEL, host: HOST },
  workspaceRoot: workspaceDir,
  maxTokens: 16384,
};
const session = new Session(engineConfig, client);

try {
  await session.run('Create a fun, modern tetris game in a single html file. Add extra features if you want.');
  console.log('session.run() completed normally');
} catch (err) {
  console.log('session.run() THREW:', (err as Error).message);
}
process.on('unhandledRejection', (err) => console.log('unhandled rejection (ignored, continuing to report):', (err as Error)?.message ?? err));

console.log(`\n--- reasoning stream (${reasoningEvents.join('').length} chars) ---`);
console.log(reasoningEvents.join('').slice(0, 2000));
console.log(`\n--- raw token stream (${allEvents.join('').length} chars) ---`);
console.log(allEvents.join('').slice(0, 2000));
console.log(`\n--- ${toolCalls.length} tool calls ---`);
for (const t of toolCalls) console.log(`  ${t.name}: ${t.argsPreview}`);

// Find every finish_reason in the raw wire log, and the exact tool-call
// argument fragments the model streamed for a write_file / edit_file call.
const raw = rawChunks.join('');
const finishReasons = [...raw.matchAll(/"finish_reason"\s*:\s*"([^"]*)"/g)].map(m => m[1]);
console.log('\n--- finish_reason values seen on the wire ---');
console.log(finishReasons);

process.exit(0);
