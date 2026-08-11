import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { filterModels } from './ModelPicker.js';
import type { ModelInfo } from '@agentionai/marshall-engine';

describe('filterModels', () => {
  const models: ModelInfo[] = [
    { id: 'nvidia/nemotron-3.5-content-safety:free', label: 'NVIDIA Content Safety' },
    { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet' },
  ];

  it('matches IDs and display labels case-insensitively', () => {
    assert.deepEqual(filterModels(models, 'NEMOTRON'), [models[0]]);
    assert.deepEqual(filterModels(models, 'claude sonnet'), [models[1]]);
  });

  it('returns all models for an empty query', () => {
    assert.deepEqual(filterModels(models, '  '), models);
  });
});
