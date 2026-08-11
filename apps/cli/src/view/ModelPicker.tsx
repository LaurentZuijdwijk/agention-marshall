// ── model picker ──────────────────────────────────────────────────────────────
//
// The searchable, scrolling model list, plus the discovery it does on mount.
// Self-contained: the wizard hands it a provider and gets back a model ID.

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { formatContext, formatBytes, formatPrice } from '@agentionai/marshall-engine';
import type { Provider, ModelInfo } from '@agentionai/marshall-engine';
import { C, G } from './theme.js';
import { Hint } from './WizardChrome.js';
import { discoverModels } from '../services/modelCatalog.js';
import { traceRender } from '../renderTrace.js';
import { windowRange } from '../format.js';

/** The row that lets a model ID be typed in when the list doesn't have it. */
export const CUSTOM = '(custom…)';

/** How many rows to show before the list starts scrolling around the cursor. */
const VISIBLE_MODELS = 9;

/** Case-insensitive typeahead matching against both the provider ID and label. */
export function filterModels(models: ModelInfo[], query: string): ModelInfo[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return models;
  return models.filter(model =>
    model.id.toLocaleLowerCase().includes(needle) ||
    model.label?.toLocaleLowerCase().includes(needle),
  );
}

function statusGlyph(model: ModelInfo): { glyph: string; color: string } {
  if (model.failed)             return { glyph: G.no,   color: C.error };
  if (model.supportsTools === false) return { glyph: G.warn, color: C.warn  };
  if (model.loaded)             return { glyph: G.tool, color: C.ok    };
  return { glyph: '○', color: C.faint };
}

/** The line under the list describing whichever model the cursor is on. */
function ModelDetail({ model }: { model: ModelInfo }) {
  if (model.id === CUSTOM) return <Hint>type any model ID the server accepts</Hint>;

  const facts: string[] = [];
  if (model.paramsLabel) facts.push(model.paramsLabel);
  if (model.quant)       facts.push(model.quant);
  if (model.sizeBytes)   facts.push(formatBytes(model.sizeBytes));
  if (model.extraModalities) facts.push(...model.extraModalities);

  if (model.pricing) {
    facts.push(`${formatPrice(model.pricing.prompt)} in · ${formatPrice(model.pricing.completion)} out`);
  }
  if (model.label) facts.push(model.label);
  if (model.context) {
    const ceiling = model.contextTrain && model.contextTrain > model.context
      ? ` of ${formatContext(model.contextTrain)} trained`
      : '';
    facts.push(
      model.contextSource === 'active'
        ? `${formatContext(model.context)} context${ceiling}`
        : `${formatContext(model.context)} context when loaded`,
    );
  }
  if (model.maxOutput) facts.push(`${formatContext(model.maxOutput)} max output`);
  if (model.reasoning) facts.push('reasoning');
  if (model.supportsTools === false) facts.push('no tool support');

  if (model.failed) facts.push('last start failed');
  else if (!model.loaded) facts.push('not loaded — first request will load it');

  return <Hint>{facts.length > 0 ? facts.join(`  ${G.bullet}  `) : 'no details reported'}</Hint>;
}

export function ModelList({
  models, onSelect, onBack,
}: {
  models: ModelInfo[];
  onSelect: (value: string) => void;
  onBack?: () => void;
}) {
  traceRender('ModelList');
  const [cursor, setCursor] = useState(0);
  const [query, setQuery] = useState('');
  const filtered = filterModels(models, query);
  const items = [...filtered, { id: CUSTOM } as ModelInfo];
  // `cursor` can point past the end of `items` for one render after a search
  // narrows the list — the effect below that resets it to 0 only runs *after*
  // that render commits, not before — so every direct index read below clamps
  // to the current `items`, rather than trusting the effect alone to keep it
  // in range. Without this, `items[cursor]` was `undefined` for that one frame
  // and crashed whatever read `.id` off it.
  const activeIndex = Math.min(cursor, items.length - 1);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  useInput((input, key) => {
    if (key.upArrow)   { setCursor(c => (c - 1 + items.length) % items.length); return; }
    if (key.downArrow) { setCursor(c => (c + 1) % items.length); return; }
    if (key.return)    { onSelect(items[activeIndex].id); return; }
    if (key.leftArrow || key.escape) {
      if (query) { setQuery(''); setCursor(0); } else onBack?.();
      return;
    }
    if (key.backspace || key.delete) { setQuery(q => q.slice(0, -1)); return; }
    if (!key.ctrl && !key.meta && !key.tab && input && /^[\x20-\x7e]+$/.test(input)) {
      setQuery(q => q + input);
    }
  });

  // Leave room for the gutter, status glyph, context and optional price column.
  const showPrice = models.some(m => m.pricing) && (process.stdout.columns ?? 80) >= 64;
  const available = Math.max(24, (process.stdout.columns ?? 80) - (showPrice ? 34 : 18));
  const nameWidth = Math.min(available, Math.max(...items.map(m => m.id.length)));

  const { start, end } = windowRange(items.length, activeIndex, VISIBLE_MODELS);
  const above = start;
  const below = items.length - end;

  return (
    <Box flexDirection="column">
      <Box paddingLeft={2}>
        <Text color={C.faint}>search </Text>
        <Text color={query ? C.brandTo : C.faint}>{query || 'type to filter'}</Text>
        {query && <Text color={C.faint}>  ({filtered.length} match{filtered.length === 1 ? '' : 'es'})</Text>}
      </Box>
      {filtered.length === 0 && <Hint>no matching models — press escape to clear</Hint>}
      {above > 0 && <Text color={C.faint}>  ↑ {above} more</Text>}

      {items.slice(start, end).map((model, i) => {
        const index = start + i;
        const active = index === activeIndex;
        const { glyph, color } = statusGlyph(model);
        const isCustom = model.id === CUSTOM;
        const name = model.id.length > nameWidth
          ? model.id.slice(0, nameWidth - 1) + '…'
          : model.id.padEnd(nameWidth);

        return (
          <Box key={model.id}>
            <Box flexShrink={0}>
              <Text color={active ? C.brandTo : C.faint} bold={active}>
                {active ? `${G.prompt} ` : '  '}
              </Text>
            </Box>
            <Box flexShrink={0}>
              <Text color={color}>{isCustom ? '  ' : `${glyph} `}</Text>
            </Box>
            <Box flexShrink={1} minWidth={4}>
              <Text color={active ? C.brandTo : C.muted} bold={active} wrap="truncate-end">{name}</Text>
            </Box>
            {model.context !== undefined && (
              <Box flexShrink={0}>
                <Text color={model.contextSource === 'active' ? C.accent : C.faint}>
                  {'  '}{formatContext(model.context).padStart(5)}
                </Text>
              </Box>
            )}
            {showPrice && model.pricing && (
              <Box flexShrink={0}>
                <Text color={C.faint}>
                  {'  '}{model.pricing.prompt === 0 && model.pricing.completion === 0
                    ? 'free'
                    : `${formatPrice(model.pricing.prompt)}/${formatPrice(model.pricing.completion)}`}
                </Text>
              </Box>
            )}
          </Box>
        );
      })}

      {below > 0 && <Text color={C.faint}>  ↓ {below} more</Text>}

      <Box marginTop={1} paddingLeft={2}>
        <ModelDetail model={items[activeIndex]} />
      </Box>
    </Box>
  );
}

export function ModelSelect({
  provider, host, apiKey, onSelect, onBack,
}: {
  provider: Provider;
  host: string;
  apiKey?: string;
  onSelect: (model: string) => void;
  onBack: () => void;
}) {
  traceRender('ModelSelect', provider);
  // null = still probing
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [note, setNote] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    discoverModels(provider, host, apiKey).then(catalogue => {
      if (!live) return;
      setModels(catalogue.models);
      setNote(catalogue.note);
    });
    return () => { live = false; };
  }, [provider, host, apiKey]);

  if (models === null) {
    return (
      <Box flexDirection="column" gap={1}>
        <Hint>probing {host}…</Hint>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      {note.length > 0 ? <Hint>{note.join(`  ${G.bullet}  `)}</Hint> : null}
      <ModelList models={models} onSelect={onSelect} onBack={onBack} />
    </Box>
  );
}
