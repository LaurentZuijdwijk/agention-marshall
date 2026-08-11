// ── model catalogue ───────────────────────────────────────────────────────────
//
// Everything the setup wizard needs to answer "which models can this provider
// run?". Kept out of the view so the request shapes and the note shown above
// the picker can be tested without rendering Ink.

import {
  parseLlamaCppModels, applyLlamaCppProps, parseOllamaModels, parseOpenRouterModels,
} from '@agentionai/marshall-engine';
import type { Provider, ModelInfo } from '@agentionai/marshall-engine';

/**
 * Offered in this order on purpose. The three providers whose model list is
 * fetched live come first — they are the ones where the wizard does real work
 * rather than showing a hardcoded preset, and openrouter and llamacpp are where
 * most sessions actually land.
 */
export const PROVIDERS: Array<{ value: Provider; hint: string }> = [
  { value: 'openrouter', hint: 'OPENROUTER_API_KEY' },
  { value: 'llamacpp',   hint: 'no key needed'      },
  { value: 'ollama',     hint: 'no key needed'      },
  { value: 'claude',     hint: 'ANTHROPIC_API_KEY' },
  { value: 'openai',     hint: 'OPENAI_API_KEY'    },
  { value: 'gemini',     hint: 'GEMINI_API_KEY'     },
  { value: 'mistral',    hint: 'MISTRAL_API_KEY'    },
];

/** The shortlist shown when live discovery fails or the provider has none. */
export const MODEL_PRESETS: Record<Provider, string[]> = {
  claude:     ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'],
  openai:     ['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra'],
  gemini:     ['gemini-2.0-flash', 'gemini-1.5-pro'],
  mistral:    ['mistral-large-latest', 'mistral-small-latest', 'codestral-latest'],
  ollama:     ['llama3.2', 'codellama', 'qwen2.5', 'deepseek-r1'],
  llamacpp:   [],
  openrouter: [],
};

export function providerHasHost(provider: Provider): boolean {
  // Only local servers ask for a URL. OpenRouter has a host in its defaults
  // (https://openrouter.ai/api/v1) but it's fixed — no input needed.
  return provider === 'ollama' || provider === 'llamacpp';
}

const TIMEOUT_MS = 3_000;

async function getJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    return res.ok ? await res.json() : null;
  } catch {
    return null; // unreachable, timed out, or not JSON
  }
}

/**
 * Probe a local model server. Tries Ollama's native API first, then the
 * OpenAI-compatible /v1/models endpoint (llama.cpp, LM Studio, LocalAI, …).
 * Returns an empty array if the server is unreachable within the timeout.
 */
async function fetchLocalModels(host: string, provider: Provider): Promise<ModelInfo[]> {
  try {
    if (provider === 'ollama') {
      const tags = await getJson(`${host}/api/tags`);
      const running = await getJson(`${host}/api/ps`);
      return parseOllamaModels(tags, running);
    }
    const models = await getJson(`${host}/v1/models`);
    if (!models) return [];
    const parsed = parseLlamaCppModels(models);
    const props = await getJson(`${host}/props`);
    return applyLlamaCppProps(parsed, props);
  } catch {
    return [];
  }
}

/** Keep the OpenAI picker useful for agent conversations, not every API product. */
export function filterOpenAIModels(models: ModelInfo[]): ModelInfo[] {
  const excluded = /(?:embedding|moderation|dall-e|whisper|tts|transcri|image|audio|realtime)/i;
  const conversational = /^(?:gpt-|o[1-9](?:-|$)|chatgpt-|codex-)/i;
  const version = (id: string): number[] =>
    (id.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  const compareLatest = (a: ModelInfo, b: ModelInfo): number => {
    const av = version(a.id);
    const bv = version(b.id);
    for (let i = 0; i < Math.max(av.length, bv.length); i++) {
      const difference = (bv[i] ?? -1) - (av[i] ?? -1);
      if (difference !== 0) return difference;
    }
    return a.id.localeCompare(b.id);
  };
  return models
    .filter(model => conversational.test(model.id) && !excluded.test(model.id))
    .sort(compareLatest)
    .slice(0, 12);
}

/**
 * Where each hosted provider lists its models, and how it wants to be
 * authenticated. Membership here is also what marks a provider as "hosted" —
 * anything absent is probed as a local server instead.
 */
const HOSTED_CATALOGUES: Partial<Record<Provider, (key: string) => { url: string; headers: Record<string, string> }>> = {
  openai:  key => ({ url: 'https://api.openai.com/v1/models',    headers: { Authorization: `Bearer ${key}` } }),
  mistral: key => ({ url: 'https://api.mistral.ai/v1/models',    headers: { Authorization: `Bearer ${key}` } }),
  claude:  key => ({ url: 'https://api.anthropic.com/v1/models', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }),
  // Gemini authenticates in the query string, so it needs no headers at all.
  gemini:  key => ({ url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`, headers: {} }),
};

/** Fetch a hosted provider's model catalogue, returning [] on any failure. */
async function fetchHostedModels(provider: Provider, apiKey?: string): Promise<ModelInfo[]> {
  const catalogue = HOSTED_CATALOGUES[provider];
  if (!catalogue || !apiKey) return [];
  const { url, headers } = catalogue(apiKey);
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return [];
    const body = await response.json() as any;
    const values = body.data ?? body.models ?? [];
    const models = values
      .map((model: any) => ({ id: model.id ?? model.name?.replace(/^models\//, '') }))
      .filter((model: ModelInfo) => model.id);
    return provider === 'openai' ? filterOpenAIModels(models) : models;
  } catch {
    return [];
  }
}

/** OpenRouter's catalogue is public; a key only personalises the listing. */
async function fetchOpenRouterModels(pinned: string[], apiKey?: string): Promise<ModelInfo[]> {
  try {
    const listed = await fetch('https://openrouter.ai/api/v1/models', {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return listed.ok ? parseOpenRouterModels(await listed.json(), pinned) : [];
  } catch {
    return [];
  }
}

export interface Catalogue {
  models: ModelInfo[];
  /**
   * Fragments for the note above the picker, joined with a bullet by the view.
   * Keeping them apart leaves the separator glyph a theme decision.
   */
  note: string[];
}

/** Every provider has a shortlist to fall back on when discovery comes up empty. */
function fallback(provider: Provider, source: string): Catalogue {
  return {
    models: MODEL_PRESETS[provider].map(id => ({ id })),
    note: [`${source} unreachable — showing defaults`],
  };
}

/**
 * The wizard's one discovery entry point: ask `provider` what it can run, and
 * describe where the answer came from. Never rejects — an unreachable server
 * degrades to the preset list rather than stalling the wizard.
 */
export async function discoverModels(
  provider: Provider,
  host: string,
  apiKey?: string,
): Promise<Catalogue> {
  if (provider === 'openrouter') {
    const fetched = await fetchOpenRouterModels(MODEL_PRESETS.openrouter, apiKey);
    return fetched.length > 0
      ? { models: fetched, note: [`${fetched.length} text models from openrouter.ai`] }
      : fallback(provider, 'openrouter.ai');
  }

  if (HOSTED_CATALOGUES[provider]) {
    const fetched = await fetchHostedModels(provider, apiKey);
    return fetched.length > 0
      ? { models: fetched, note: [`${fetched.length} models from ${provider}`] }
      : fallback(provider, provider);
  }

  const fetched = await fetchLocalModels(host, provider);
  if (fetched.length === 0) return fallback(provider, host);

  // Resident models first — those answer instantly, the rest pay a load.
  const ordered = [...fetched].sort((a, b) => Number(b.loaded ?? false) - Number(a.loaded ?? false));
  const live = fetched.filter(model => model.loaded).length;
  return {
    models: ordered,
    note: [
      `${fetched.length} model${fetched.length === 1 ? '' : 's'} from ${host}`,
      ...(live > 0 ? [`${live} loaded`] : []),
    ],
  };
}
