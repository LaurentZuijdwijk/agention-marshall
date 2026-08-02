import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLlamaCppModels, applyLlamaCppProps, parseOllamaModels, parseOpenRouterModels,
  formatContext, formatParams, formatBytes,
} from './models.js';

// Shapes below are trimmed from real responses: a llama.cpp router at
// b10148-ddfc2288e and Ollama's documented /api/tags + /api/ps.

const LOADED = {
  id: 'Qwen3.6-27B-Uncensored-HauhauCS-Balanced-MTP-Q6_K_P',
  object: 'model',
  owned_by: 'llamacpp',
  status: {
    value: 'loaded',
    args: ['llama-server', '--ctx-size', '131072', '--model', 'q.gguf'],
    preset: '[Q]\nctx-size = 131072\n',
  },
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  meta: {
    n_ctx: 131072, n_ctx_train: 262144, n_params: 27320697856,
    size: 23595286784, ftype: 'Q6_K', n_embd: 5120, n_vocab: 248320,
  },
};

const UNLOADED_WITH_ARGS = {
  id: 'MiniMax/MiniMax-M2.7-APEX-I-Compact.gguf',
  status: { value: 'unloaded', args: ['llama-server', '--ctx-size', '80000'], preset: '[M]\n' },
};

const UNLOADED_PRESET_ONLY = {
  id: 'Gemma-4-E4B-MTP',
  status: { value: 'unloaded', args: ['llama-server', '--jinja'], preset: '[G]\nctx-size = 40960\nmmap = off\n' },
};

const UNLOADED_BARE = {
  id: 'unsloth/Inkling-Small-GGUF:IQ3_XXS',
  status: { value: 'unloaded', args: ['llama-server', '--jinja'], preset: '[I]\nmmap = off\n' },
};

const FAILED = {
  id: 'Gemma-4-31B-it-i1-Q4_K_M',
  status: { value: 'unloaded', args: ['llama-server'], preset: '[G]\n', exit_code: 1, failed: true },
};

// ── llama.cpp ─────────────────────────────────────────────────────────────────

describe('parseLlamaCppModels', () => {
  it('reads a loaded model in full', () => {
    const [m] = parseLlamaCppModels({ data: [LOADED] });
    assert.equal(m.id, LOADED.id);
    assert.equal(m.loaded, true);
    assert.equal(m.context, 131072);
    assert.equal(m.contextSource, 'active');
    assert.equal(m.contextTrain, 262144);
    assert.equal(m.paramsLabel, '27B');
    assert.equal(m.quant, 'Q6_K');
    assert.equal(m.sizeBytes, 23595286784);
  });

  it('takes the configured context from launch args when not loaded', () => {
    const [m] = parseLlamaCppModels({ data: [UNLOADED_WITH_ARGS] });
    assert.equal(m.loaded, undefined);
    assert.equal(m.context, 80000);
    assert.equal(m.contextSource, 'configured');
  });

  it('falls back to the preset block when args carry no ctx-size', () => {
    const [m] = parseLlamaCppModels({ data: [UNLOADED_PRESET_ONLY] });
    assert.equal(m.context, 40960);
    assert.equal(m.contextSource, 'configured');
  });

  it('reports no context rather than inventing one', () => {
    const [m] = parseLlamaCppModels({ data: [UNLOADED_BARE] });
    assert.equal(m.context, undefined);
    assert.equal(m.contextSource, undefined);
  });

  it('flags a model whose last start failed', () => {
    const [m] = parseLlamaCppModels({ data: [FAILED] });
    assert.equal(m.failed, true);
    assert.equal(m.loaded, undefined);
  });

  it('reports input modalities beyond text', () => {
    const [m] = parseLlamaCppModels({
      data: [{ id: 'v', architecture: { input_modalities: ['text', 'image', 'audio'] } }],
    });
    assert.deepEqual(m.extraModalities, ['image', 'audio']);
  });

  it('reports nothing extra for a text-only model', () => {
    const [m] = parseLlamaCppModels({
      data: [{ id: 'v', architecture: { input_modalities: ['text'] } }],
    });
    assert.equal(m.extraModalities, undefined);
  });

  it('survives a plain OpenAI-compatible server with no extras', () => {
    const [m] = parseLlamaCppModels({ data: [{ id: 'gpt-x', object: 'model' }] });
    assert.deepEqual(m, { id: 'gpt-x' });
  });

  it('ignores malformed payloads and entries', () => {
    assert.deepEqual(parseLlamaCppModels(null), []);
    assert.deepEqual(parseLlamaCppModels({}), []);
    assert.deepEqual(parseLlamaCppModels({ data: 'nope' }), []);
    assert.deepEqual(parseLlamaCppModels({ data: [{ id: '' }, { nope: 1 }, null] }), []);
  });

  it('keeps every model from the real 16-entry response', () => {
    const data = [LOADED, UNLOADED_WITH_ARGS, UNLOADED_PRESET_ONLY, UNLOADED_BARE, FAILED];
    assert.equal(parseLlamaCppModels({ data }).length, 5);
  });
});

describe('applyLlamaCppProps', () => {
  it('leaves router results alone — each model has its own state', () => {
    const models = parseLlamaCppModels({ data: [UNLOADED_WITH_ARGS] });
    const out = applyLlamaCppProps(models, {
      role: 'router', default_generation_settings: { n_ctx: 0 },
    });
    assert.equal(out[0].loaded, undefined);
    assert.equal(out[0].contextSource, 'configured');
  });

  it('marks the single model of a plain server loaded, with its live context', () => {
    const models = parseLlamaCppModels({ data: [{ id: 'solo' }] });
    const out = applyLlamaCppProps(models, {
      model_path: '/models/solo.gguf', default_generation_settings: { n_ctx: 8192 },
    });
    assert.equal(out[0].loaded, true);
    assert.equal(out[0].context, 8192);
    assert.equal(out[0].contextSource, 'active');
  });

  it('does nothing without usable props', () => {
    const models = parseLlamaCppModels({ data: [{ id: 'solo' }] });
    assert.deepEqual(applyLlamaCppProps(models, null), models);
    assert.deepEqual(applyLlamaCppProps(models, { default_generation_settings: { n_ctx: 0 } }), models);
  });
});

// ── ollama ────────────────────────────────────────────────────────────────────

const TAGS = {
  models: [
    { name: 'qwen2.5:7b', size: 4683087519, details: { parameter_size: '7.6B', quantization_level: 'Q4_K_M' } },
    { name: 'codellama:13b', size: 7365960935, details: { parameter_size: '13B', quantization_level: 'Q4_0' } },
  ],
};

describe('parseOllamaModels', () => {
  it('reads sizes and quantisation from the tag list', () => {
    const [a] = parseOllamaModels(TAGS);
    assert.equal(a.id, 'qwen2.5:7b');
    assert.equal(a.paramsLabel, '7.6B');
    assert.equal(a.quant, 'Q4_K_M');
    assert.equal(a.sizeBytes, 4683087519);
    assert.equal(a.loaded, undefined);
  });

  it('marks resident models from /api/ps and takes their context', () => {
    const models = parseOllamaModels(TAGS, {
      models: [{ name: 'qwen2.5:7b', size_vram: 5000, context_length: 32768 }],
    });
    assert.equal(models[0].loaded, true);
    assert.equal(models[0].context, 32768);
    assert.equal(models[0].contextSource, 'active');
    assert.equal(models[1].loaded, undefined);
  });

  it('still lists everything when /api/ps is unavailable', () => {
    assert.equal(parseOllamaModels(TAGS, null).length, 2);
  });

  it('maps ollama\'s vision capability onto the image modality', () => {
    const [m] = parseOllamaModels({
      models: [{ name: 'llava', capabilities: ['vision', 'tools'] }],
    });
    assert.deepEqual(m.extraModalities, ['image']);
  });

  it('ignores malformed payloads', () => {
    assert.deepEqual(parseOllamaModels(null), []);
    assert.deepEqual(parseOllamaModels({ models: [{ nope: 1 }] }), []);
  });
});

// ── formatting ────────────────────────────────────────────────────────────────

describe('formatting', () => {
  it('quotes context in decimal thousands', () => {
    assert.equal(formatContext(131072), '131k');
    assert.equal(formatContext(120000), '120k');
    assert.equal(formatContext(8192), '8k');
    assert.equal(formatContext(1048576), '1.0M');
    assert.equal(formatContext(512), '512');
    assert.equal(formatContext(0), '');
  });

  it('formats parameter counts', () => {
    assert.equal(formatParams(27320697856), '27B');
    assert.equal(formatParams(7600000000), '7.6B');
    assert.equal(formatParams(0), '');
  });

  it('formats sizes', () => {
    assert.equal(formatBytes(23595286784), '22.0 GB');
    assert.equal(formatBytes(0), '');
  });
});

// ── openrouter ────────────────────────────────────────────────────────────────

const OR_CODING = {
  id: 'anthropic/claude-sonnet-5',
  created: 1782843083,
  context_length: 1000000,
  architecture: { input_modalities: ['text', 'image', 'file'], output_modalities: ['text'] },
  supported_parameters: ['max_tokens', 'tools', 'temperature'],
  pricing: { prompt: '0.000002', completion: '0.00001' },
};
const OR_OLDER = {
  id: 'deepseek/deepseek-v4-flash',
  created: 1777000666,
  context_length: 1048576,
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  supported_parameters: ['tools'],
  pricing: { prompt: '0.00000014', completion: '0.00000028' },
};
const OR_IMAGE_GEN = {
  id: 'google/gemini-3.1-flash-image',
  created: 1781754065,
  architecture: { input_modalities: ['image', 'text'], output_modalities: ['image', 'text'] },
  supported_parameters: ['max_tokens'],
  pricing: { prompt: '0.0000005', completion: '0.000003' },
};
const OR_ROUTER = {
  id: 'openrouter/auto',
  created: 1699401600,
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  supported_parameters: ['tools'],
  pricing: { prompt: '-1', completion: '-1' },
};
const OR_NO_TOOLS = {
  id: 'qwen/qwen3-8b',
  created: 1745876632,
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  supported_parameters: ['temperature'],
  pricing: { prompt: '0.0000001', completion: '0.0000004' },
};
const OR_ROLEPLAY = {
  id: 'thedrummer/cydonia-24b-v4.1',
  created: 1758931878,
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  supported_parameters: ['tools'],
  pricing: { prompt: '0.0000003', completion: '0.0000005' },
};

describe('parseOpenRouterModels', () => {
  const payload = { data: [OR_CODING, OR_OLDER, OR_IMAGE_GEN, OR_ROUTER, OR_NO_TOOLS, OR_ROLEPLAY] };

  it('keeps text-out tool-calling models from headline families', () => {
    const ids = parseOpenRouterModels(payload).map(m => m.id);
    assert.deepEqual(ids, [OR_CODING.id, OR_OLDER.id]);
  });

  it('drops image generation, meta-routers, non-tool and off-family models', () => {
    const ids = parseOpenRouterModels(payload).map(m => m.id);
    for (const dropped of [OR_IMAGE_GEN.id, OR_ROUTER.id, OR_NO_TOOLS.id, OR_ROLEPLAY.id]) {
      assert.ok(!ids.includes(dropped), `${dropped} should be filtered out`);
    }
  });

  it('sorts pinned presets first, then newest first', () => {
    const ids = parseOpenRouterModels(payload, [OR_OLDER.id]).map(m => m.id);
    assert.deepEqual(ids, [OR_OLDER.id, OR_CODING.id]);
  });

  it('puts free models first within each tier', () => {
    const freeOlder = { ...OR_OLDER, id: OR_OLDER.id + ':free' };
    const data = [OR_CODING, freeOlder];
    assert.deepEqual(parseOpenRouterModels({ data }).map(m => m.id), [freeOlder.id, OR_CODING.id]);
  });

  it('drops the removed pinned defaults', () => {
    const id = 'anthropic/claude-sonnet-4.6';
    const removed = parseOpenRouterModels({ data: [OR_CODING, { ...OR_NO_TOOLS, id }] }).map(m => m.id);
    assert.ok(!removed.includes(id), `${id} should be excluded`);
  });

  it('carries context and extra input modalities', () => {
    const [m] = parseOpenRouterModels(payload);
    assert.equal(m.context, 1000000);
    assert.equal(m.contextSource, 'configured');
    assert.deepEqual(m.extraModalities, ['image', 'file']);
  });

  it('returns an empty list for an unrecognised payload', () => {
    assert.deepEqual(parseOpenRouterModels({}), []);
    assert.deepEqual(parseOpenRouterModels(null), []);
  });
});
