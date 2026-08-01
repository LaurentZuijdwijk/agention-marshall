import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from './TextInput.js';
import { PROVIDER_DEFAULTS } from '@marshall/engine';
import type { Provider, Tier } from '@marshall/engine';
import { C, G, brand } from './theme.js';
import { traceRender } from './renderTrace.js';
import {
  parseLlamaCppModels, applyLlamaCppProps, parseOllamaModels, parseOpenRouterModels,
  formatContext, formatBytes, windowRange,
} from './models.js';
import type { ModelInfo } from './models.js';

// ── data ──────────────────────────────────────────────────────────────────────

const PROVIDERS: Array<{ value: Provider; hint: string }> = [
  { value: 'claude',     hint: 'ANTHROPIC_API_KEY' },
  { value: 'openai',     hint: 'OPENAI_API_KEY'    },
  { value: 'gemini',     hint: 'GEMINI_API_KEY'     },
  { value: 'mistral',    hint: 'MISTRAL_API_KEY'    },
  { value: 'ollama',     hint: 'no key needed'      },
  { value: 'llamacpp',   hint: 'no key needed'      },
  { value: 'openrouter', hint: 'OPENROUTER_API_KEY' },
];

const MODEL_PRESETS: Record<Provider, string[]> = {
  claude:     ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'],
  openai:     ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
  gemini:     ['gemini-2.0-flash', 'gemini-1.5-pro'],
  mistral:    ['mistral-large-latest', 'mistral-small-latest', 'codestral-latest'],
  ollama:     ['llama3.2', 'codellama', 'qwen2.5', 'deepseek-r1'],
  llamacpp:   [],
  openrouter: [],
};

const CUSTOM = '(custom…)';

function providerHasHost(provider: Provider): boolean {
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
async function fetchLocalModels(host: string): Promise<ModelInfo[]> {
  // Ollama native. /api/ps tells us which of them are actually resident; it is
  // a nice-to-have, so a failure there still leaves us with the full list.
  const tags = await getJson(`${host}/api/tags`);
  if (tags) {
    const running = await getJson(`${host}/api/ps`);
    const models = parseOllamaModels(tags, running);
    if (models.length > 0) return models;
  }

  // OpenAI-compatible. /props distinguishes a llama.cpp router (many models,
  // each with its own load state) from a plain single-model server.
  const listed = await getJson(`${host}/v1/models`);
  if (listed) {
    const models = parseLlamaCppModels(listed);
    if (models.length > 0) return applyLlamaCppProps(models, await getJson(`${host}/props`));
  }

  return [];
}

/** OpenRouter's public catalogue — no key required, already curated. */
async function fetchOpenRouterModels(pinned: string[]): Promise<ModelInfo[]> {
  const listed = await getJson('https://openrouter.ai/api/v1/models');
  return listed ? parseOpenRouterModels(listed, pinned) : [];
}

// ── title ─────────────────────────────────────────────────────────────────────

const WORDMARK = 'marshall';

/** Gradient wordmark plus the current step, shared by every wizard screen. */
function Title({ step }: { step: string }) {
  traceRender('Title', step.slice(0, 30));
  return (
    <Box>
      <Box flexShrink={0}>
        <Text>
          {[...WORDMARK].map((ch, i) => (
            <Text key={i} bold color={brand(i / (WORDMARK.length - 1))}>{ch}</Text>
          ))}
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Text color={C.faint}>  {G.bullet}  </Text>
      </Box>
      <Box flexGrow={1} minWidth={8}>
        <Text color={C.muted} wrap="truncate-end">{step}</Text>
      </Box>
    </Box>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  traceRender('Hint');
  // wrap={false}: a hint is one line of chrome, never prose. Letting it wrap
  // means a narrow terminal asks Yoga to measure it at <1 column, which is
  // the state that used to send wrap-ansi into a runaway allocation.
  return <Text color={C.faint} wrap="truncate-end">{children}</Text>;
}

// ── provider select ───────────────────────────────────────────────────────────

/** Sentinel row offered when picking the fast tier — means "don't tier at all". */
const SAME_AS_DEEP = '(same as deep)';

function ProviderSelect({ onSelect, onBack, offerSameAsDeep }: {
  onSelect: (p: Provider | typeof SAME_AS_DEEP) => void;
  onBack: () => void;
  offerSameAsDeep?: boolean;
}) {
  const rows: Array<{ value: Provider | typeof SAME_AS_DEEP; hint: string }> = offerSameAsDeep
    ? [{ value: SAME_AS_DEEP, hint: 'no tiering — one model does everything' }, ...PROVIDERS]
    : PROVIDERS;

  const [cursor, setCursor] = useState(0);

  useInput((_, key) => {
    if (key.upArrow)   { setCursor(c => (c - 1 + rows.length) % rows.length); return; }
    if (key.downArrow) { setCursor(c => (c + 1) % rows.length); return; }
    if (key.return)    { onSelect(rows[cursor].value); return; }
    if (key.escape)    { onBack(); return; }
  });

  return (
    <Box flexDirection="column">
      {rows.map((p, i) => {
        const active = i === cursor;
        return (
          <Box key={p.value}>
            <Box flexShrink={0}>
              <Text color={active ? C.brandTo : C.faint} bold={active}>
                {active ? `${G.prompt} ` : '  '}
              </Text>
            </Box>
            <Box flexShrink={0}>
              <Text color={active ? C.brandTo : C.muted} bold={active}>{p.value.padEnd(16)}</Text>
            </Box>
            <Box flexGrow={1} minWidth={8}>
              <Text color={C.faint} wrap="truncate-end">{p.hint}</Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

// ── host input ────────────────────────────────────────────────────────────────

function BackableTextInput({
  value, onChange, onSubmit, onBack, placeholder, mask,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  onBack: () => void;
  placeholder?: string;
  mask?: string;
}) {
  traceRender('BackableTextInput', `len=${value.length} cols=${process.stdout.columns}`);
  useInput((_, key) => {
    if (key.escape) onBack();
  });

  // The prompt glyph must not compete with the input for space. Without
  // flexShrink={0} on the glyph and a minWidth on the field, flex shrink can
  // drive the input's width to zero — and Ink then asks wrap-ansi to wrap text
  // into zero columns, which never terminates and allocates until the heap
  // dies. Reserving room makes that state unreachable rather than unlikely.
  return (
    <Box paddingX={1} flexDirection="row">
      <Box flexShrink={0}>
        <Text color={C.brandTo} bold>{G.prompt} </Text>
      </Box>
      <Box flexGrow={1} minWidth={16}>
        <TextInput value={value} onChange={onChange} onSubmit={onSubmit} placeholder={placeholder} mask={mask} />
      </Box>
    </Box>
  );
}

// ── model select ──────────────────────────────────────────────────────────────

function ModelSelect({
  provider, host, onSelect, onBack,
}: {
  provider: Provider;
  host: string;
  onSelect: (model: string) => void;
  onBack: () => void;
}) {
  traceRender('ModelSelect', provider);
  const fetchesModels = provider === 'ollama' || provider === 'llamacpp' || provider === 'openrouter';
  const presets = (): ModelInfo[] => MODEL_PRESETS[provider].map(id => ({ id }));

  // null = still probing the server
  const [models, setModels] = useState<ModelInfo[] | null>(
    fetchesModels ? null : presets(),
  );
  const [fetchNote, setFetchNote] = useState('');

  useEffect(() => {
    if (!fetchesModels) return;

    if (provider === 'openrouter') {
      fetchOpenRouterModels(MODEL_PRESETS.openrouter).then(fetched => {
        if (fetched.length > 0) {
          setModels(fetched);
          setFetchNote(`${fetched.length} coding-capable models from openrouter.ai`);
        } else {
          setModels(presets());
          setFetchNote('openrouter.ai unreachable — showing defaults');
        }
      });
      return;
    }

    fetchLocalModels(host).then(fetched => {
      if (fetched.length > 0) {
        // Resident models first — those answer instantly, the rest pay a load.
        const ordered = [...fetched].sort((a, b) => Number(b.loaded ?? false) - Number(a.loaded ?? false));
        const live = fetched.filter(m => m.loaded).length;
        setModels(ordered);
        setFetchNote(
          `${fetched.length} model${fetched.length === 1 ? '' : 's'} from ${host}` +
          (live > 0 ? `  ${G.bullet}  ${live} loaded` : ''),
        );
      } else {
        setModels(presets());
        setFetchNote(`${host} unreachable — showing defaults`);
      }
    });
  }, [provider, host]); // eslint-disable-line react-hooks/exhaustive-deps

  if (models === null) {
    return (
      <Box flexDirection="column" gap={1}>
        <Hint>probing {host}…</Hint>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      {fetchNote ? <Hint>{fetchNote}</Hint> : null}
      <ModelList models={models} onSelect={onSelect} onBack={onBack} />
    </Box>
  );
}

// ── model list ────────────────────────────────────────────────────────────────

/** How many rows to show before the list starts scrolling around the cursor. */
const VISIBLE_MODELS = 9;

function statusGlyph(model: ModelInfo): { glyph: string; color: string } {
  if (model.failed)   return { glyph: G.no,   color: C.error };
  if (model.loaded)   return { glyph: G.tool, color: C.ok    };
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

  if (model.failed) facts.push('last start failed');
  else if (!model.loaded) facts.push('not loaded — first request will load it');

  return <Hint>{facts.length > 0 ? facts.join(`  ${G.bullet}  `) : 'no details reported'}</Hint>;
}

function ModelList({
  models, onSelect, onBack,
}: {
  models: ModelInfo[];
  onSelect: (value: string) => void;
  onBack?: () => void;
}) {
  traceRender('ModelList');
  const [cursor, setCursor] = useState(0);
  const items = [...models, { id: CUSTOM } as ModelInfo];

  useInput((_, key) => {
    if (key.upArrow)   { setCursor(c => (c - 1 + items.length) % items.length); return; }
    if (key.downArrow) { setCursor(c => (c + 1) % items.length); return; }
    if (key.return)    { onSelect(items[cursor].id); return; }
    if (key.leftArrow || key.escape) { onBack?.(); return; }
  });

  // Leave room for the gutter, status glyph and the context column.
  const available = Math.max(24, (process.stdout.columns ?? 80) - 18);
  const nameWidth = Math.min(available, Math.max(...items.map(m => m.id.length)));

  const { start, end } = windowRange(items.length, cursor, VISIBLE_MODELS);
  const above = start;
  const below = items.length - end;

  return (
    <Box flexDirection="column">
      {above > 0 && <Text color={C.faint}>  ↑ {above} more</Text>}

      {items.slice(start, end).map((model, i) => {
        const index = start + i;
        const active = index === cursor;
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
          </Box>
        );
      })}

      {below > 0 && <Text color={C.faint}>  ↓ {below} more</Text>}

      <Box marginTop={1} paddingLeft={2}>
        <ModelDetail model={items[cursor]} />
      </Box>
    </Box>
  );
}

// ── setup wizard ──────────────────────────────────────────────────────────────

type Step =
  | { name: 'provider' }
  | { name: 'host'; provider: Provider }
  | { name: 'model'; provider: Provider; host?: string }
  | { name: 'custom'; provider: Provider; host?: string }
  | { name: 'key'; provider: Provider; model: string; host?: string };

export interface SetupProps {
  initial?: { provider?: Provider; model?: string; host?: string };
  /**
   * Which tier is being chosen. `fast` gets a "same as deep" escape and
   * different framing — it is the delegation target, not the main model.
   */
  tier?: Tier;
  /** Model the deep tier is on, shown while picking `fast` for contrast. */
  deepLabel?: string;
  /** `model === null` means "same as deep" — clear any fast override. */
  onComplete: (provider: Provider | null, model: string | null, host?: string, apiKey?: string) => void;
  /**
   * Cancel the wizard outright (ESC from the provider step). Returns to the
   * default chat screen instead of proceeding — how a `/model` was aborted.
   */
  onExit?: () => void;
}

/** What each tier is *for*, so the choice isn't guesswork. */
const TIER_BLURB: Record<Tier, string> = {
  deep: 'writes code, plans and reviews',
  fast: 'reads files, searches and summarises for the deep model',
};

export function Setup({ initial, tier = 'deep', deepLabel, onComplete, onExit }: SetupProps) {
  const [step, setStep] = useState<Step>({ name: 'provider' });
  traceRender('Setup', `step=${step.name}`);
  const [hostInput, setHostInput] = useState('');
  const [customInput, setCustomInput] = useState('');
  const [keyInput, setKeyInput] = useState('');

  const defaultHostFor = (provider: Provider): string => {
    const providerDefault = PROVIDER_DEFAULTS[provider];
    return initial?.host ?? ('host' in providerDefault ? providerDefault.host : '') ?? '';
  };

  // A provider with an envKey and no key already in the environment needs one
  // from the user before the session can start — ask right after the model.
  const needsKey = (provider: Provider): boolean => {
    const envKey = PROVIDER_DEFAULTS[provider].envKey;
    return envKey !== null && !process.env[envKey];
  };

  const finish = (provider: Provider, model: string, host?: string) => {
    if (needsKey(provider)) setStep({ name: 'key', provider, model, host });
    else onComplete(provider, model, host);
  };

  const label = (rest: string) => `${tier} model  ${G.bullet}  ${rest}`;

  if (step.name === 'provider') {
    return (
      <Box flexDirection="column" gap={1}>
        <Title step={label('choose a provider')} />
        <Box flexDirection="column">
          <Hint>{TIER_BLURB[tier]}</Hint>
          {tier === 'fast' && deepLabel ? <Hint>{`deep model is ${deepLabel}`}</Hint> : null}
        </Box>
        <ProviderSelect
          offerSameAsDeep={tier === 'fast'}
          onBack={onExit ?? (() => {})}
          onSelect={(p) => {
            if (p === SAME_AS_DEEP) { onComplete(null, null); return; }
            if (providerHasHost(p)) {
              setHostInput(defaultHostFor(p));
              setStep({ name: 'host', provider: p });
            } else {
              setStep({ name: 'model', provider: p });
            }
          }}
        />
        <Hint>{`↑↓ move ${G.bullet} enter select${onExit ? ` ${G.bullet} esc cancel` : ''}`}</Hint>
      </Box>
    );
  }

  if (step.name === 'host') {
    const { provider } = step;
    return (
      <Box flexDirection="column" gap={1}>
        <Title step={label(`${provider}  ${G.bullet}  server URL`)} />
        <BackableTextInput
          value={hostInput}
          onChange={setHostInput}
          onSubmit={(val) => {
            const h = val.trim() || defaultHostFor(provider);
            setStep({ name: 'model', provider, host: h });
          }}
          onBack={() => setStep({ name: 'provider' })}
        />
        <Hint>{`enter confirms ${G.bullet} esc back`}</Hint>
      </Box>
    );
  }

  if (step.name === 'model') {
    const { provider, host } = step;
    const resolvedHost = host ?? defaultHostFor(provider);

    return (
      <Box flexDirection="column" gap={1}>
        <Title step={label(`${provider}  ${G.bullet}  choose a model`)} />
        <ModelSelect
          provider={provider}
          host={resolvedHost}
          onSelect={(val) => {
            if (val === CUSTOM) {
              setStep({ name: 'custom', provider, host });
            } else {
              finish(provider, val, host);
            }
          }}
          onBack={() => (providerHasHost(provider) ? setStep({ name: 'host', provider }) : setStep({ name: 'provider' }))}
        />
        <Hint>{`↑↓ move ${G.bullet} enter select ${G.bullet} ← / esc back`}</Hint>
      </Box>
    );
  }

  if (step.name === 'key') {
    const { provider, model, host } = step;
    const envKey = PROVIDER_DEFAULTS[provider].envKey!;
    return (
      <Box flexDirection="column" gap={1}>
        <Title step={label(`${provider}  ${G.bullet}  API key`)} />
        <BackableTextInput
          value={keyInput}
          onChange={setKeyInput}
          onSubmit={(val) => {
            const k = val.trim();
            if (k) onComplete(provider, model, host, k);
          }}
          onBack={() => setStep({ name: 'model', provider, host })}
          placeholder={`${envKey} (stored in .marshall/config.json)`}
          mask="*"
        />
        <Hint>{`enter confirms ${G.bullet} esc back ${G.bullet} or set ${envKey} in your environment instead`}</Hint>
      </Box>
    );
  }

  // custom model input
  const { provider, host } = step;
  return (
    <Box flexDirection="column" gap={1}>
      <Title step={label(`${provider}  ${G.bullet}  enter model ID`)} />
      <BackableTextInput
        value={customInput}
        onChange={setCustomInput}
        onSubmit={(val) => {
          const m = val.trim();
          if (m) finish(provider, m, host);
        }}
        onBack={() => setStep({ name: 'model', provider, host })}
        placeholder={PROVIDER_DEFAULTS[provider].model}
      />
      <Hint>{`enter confirms ${G.bullet} esc back`}</Hint>
    </Box>
  );
}
