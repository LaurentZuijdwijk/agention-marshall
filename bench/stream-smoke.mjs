// Smoke test for @agentionai/agents' OpenAI-compatible streaming, against a fake
// SSE server. The wire format is the risky part — fragmented tool_call deltas and
// vendor reasoning fields are what a live server actually sends and what a mocked
// unit test cannot pin down. Covers:
//   1. text deltas → StreamChunk{text} + AgentEvent.CHUNK + assembled final text
//   2. fragmented tool_call deltas → reassembled into a real tool execution
//   3. reasoning deltas → StreamChunk{reasoning} + AgentEvent.REASONING_CHUNK
//   4. usage accumulated across the tool round-trip
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { LlamaCppAgent } from '@agentionai/agents/llamacpp';
import { History, AgentEvent } from '@agentionai/agents/core';

const sse = (chunks) =>
  chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';

let requestCount = 0;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    requestCount++;
    const parsed = JSON.parse(body);
    assert.equal(parsed.stream, true, 'request must be streaming');
    res.writeHead(200, { 'content-type': 'text/event-stream' });

    const hasToolResult = parsed.messages.some(m => m.role === 'tool');
    if (!hasToolResult && requestCount === 1 && parsed.tools) {
      // Turn 1: prose, then a tool call fragmented across chunks.
      res.end(sse([
        { choices: [{ index: 0, delta: { role: 'assistant' } }] },
        { choices: [{ index: 0, delta: { content: 'Checking' } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_we', arguments: '' } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'ather', arguments: '{"city":"ams' } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'terdam"}' } }] } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        // Usage arrives in its own choice-less chunk, which is what a server sends
        // back when the client asks for `stream_options: { include_usage: true }`.
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
      ]));
    } else {
      // Turn 2 (or no-tool run): stream reasoning + text. `reasoning_content` is
      // the DeepSeek/llama.cpp spelling, and the only one the library reads today
      // — OpenRouter's `reasoning` is dropped, so its chain-of-thought does not
      // reach ctrl-R. Fix belongs upstream in OpenAICompatibleAgent.streamTurn().
      res.end(sse([
        { choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'thinking ' } }] },
        { choices: [{ index: 0, delta: { reasoning_content: 'hard' } }] },
        { choices: [{ index: 0, delta: { content: 'Hello' } }] },
        { choices: [{ index: 0, delta: { content: ' world' } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 20, completion_tokens: 7, total_tokens: 27 } },
      ]));
    }
  });
});

await new Promise(r => server.listen(0, r));
const port = server.address().port;

const chunks = [];
const events = [];
const toolUses = [];

const fakeTool = {
  getPrompt: () => ({ name: 'get_weather', description: 'Get weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }),
  execute: async (_id, _name, args) => {
    assert.deepEqual(args, { city: 'amsterdam' }, 'tool args reassembled from fragments');
    return { temp: 12 };
  },
  on: () => {},
};

const agent = new LlamaCppAgent(
  { id: 't', name: 't', description: 't', apiKey: 'x', baseURL: `http://127.0.0.1:${port}/v1`, model: 'test-model' },
  new History(),
);
agent.tools.set('get_weather', fakeTool);
agent.on(AgentEvent.CHUNK, t => events.push(['text', t]));
agent.on(AgentEvent.REASONING_CHUNK, t => events.push(['reasoning', t]));
agent.on(AgentEvent.TOOL_USE, c => toolUses.push(c));

for await (const chunk of agent.executeStream('weather?')) chunks.push(chunk);

const joined = (source, type) =>
  source.filter(c => (Array.isArray(c) ? c[0] : c.type) === type)
    .map(c => (Array.isArray(c) ? c[1] : c.content)).join('');

assert.equal(joined(chunks, 'text'), 'CheckingHello world', 'every turn streams its text');
assert.equal(joined(chunks, 'reasoning'), 'thinking hard', 'reasoning chunks are separated from text');
assert.equal(joined(events, 'text'), joined(chunks, 'text'), 'CHUNK events mirror the generator');
assert.equal(joined(events, 'reasoning'), joined(chunks, 'reasoning'), 'REASONING_CHUNK events mirror the generator');
assert.equal(toolUses.length, 1, 'one TOOL_USE');
assert.equal(toolUses[0][0].function.name, 'get_weather', 'tool name reassembled');
assert.equal(toolUses[0][0].function.arguments, '{"city":"amsterdam"}', 'tool args reassembled');
assert.equal(agent.lastTokenUsage.total_tokens, 42, 'usage accumulated across turns');

server.close();
console.log('streaming smoke test: PASS');
