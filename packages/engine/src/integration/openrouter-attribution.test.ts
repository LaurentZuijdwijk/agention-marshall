// ── engine integration: OpenRouter app attribution ────────────────────────────
//
// Attribution only counts if the headers actually leave the process, and they
// are set three layers down (createAgent → OpenAICompatibleAgent → the openai
// SDK's defaultHeaders). So this asserts on the wire, against the fake
// provider, rather than on the config object we handed over.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { History } from '@agentionai/agents/core';
import { createAgent, OPENROUTER_ATTRIBUTION } from '../agent-factory.js';
import { startFakeProvider } from '../testing/fake-provider.js';
import type { AgentProfile } from '../config.js';

/** The openrouter branch takes a full `/v1` base URL, unlike ollama/llamacpp. */
function routerProfile(host: string): AgentProfile {
  return { provider: 'openrouter', host: `${host}/v1`, model: 'test-model', apiKey: 'sk-test' };
}

test('an OpenRouter turn carries the attribution headers', async () => {
  const fake = await startFakeProvider({ text: 'done' });
  try {
    const agent = await createAgent(routerProfile(fake.host), [], new History());
    await agent.execute('hello');

    const { headers } = fake.requests[0];
    assert.equal(headers['http-referer'], 'https://marshall.agention.ai');
    assert.equal(headers['x-openrouter-title'], 'Marshall');
    assert.equal(headers['x-openrouter-categories'], 'cli-agent');
    // The headers must not have displaced the key: `defaultHeaders` wins over
    // everything the SDK sets, auth included.
    assert.equal(headers.authorization, 'Bearer sk-test');
  } finally {
    await fake.close();
  }
});

test('other OpenAI-compatible providers send no attribution', async () => {
  const fake = await startFakeProvider({ text: 'done' });
  try {
    const profile: AgentProfile = { provider: 'llamacpp', host: fake.host, model: 'test-model' };
    const agent = await createAgent(profile, [], new History());
    await agent.execute('hello');

    const { headers } = fake.requests[0];
    for (const name of Object.keys(OPENROUTER_ATTRIBUTION)) {
      assert.equal(headers[name.toLowerCase()], undefined, `${name} leaked to a local server`);
    }
  } finally {
    await fake.close();
  }
});
