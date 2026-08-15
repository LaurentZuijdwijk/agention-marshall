// ── setup wizard ──────────────────────────────────────────────────────────────
//
// The provider → host → key → model walk, and nothing else: discovery lives in
// services/modelCatalog, the picker in ModelPicker, the frame in WizardChrome.

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { PROVIDER_DEFAULTS } from '@agentionai/marshall-engine';
import type { Provider, Tier } from '@agentionai/marshall-engine';
import type { ProviderRef } from '../services/config-store.js';
import { C, G } from './theme.js';
import { Title, Hint, BackableTextInput } from './WizardChrome.js';
import { CUSTOM, ModelSelect } from './ModelPicker.js';
import { PROVIDERS, providerHasHost } from '../services/modelCatalog.js';
import { traceRender } from '../renderTrace.js';

// ── provider select ───────────────────────────────────────────────────────────

/** Sentinel row offered when picking the fast tier — means "don't tier at all". */
const SAME_AS_DEEP = '(same as deep)';

function ProviderSelect({ onSelect, onBack, offerSameAsDeep, customProviders }: {
  onSelect: (p: Provider | typeof SAME_AS_DEEP, name?: string) => void;
  onBack: () => void;
  offerSameAsDeep?: boolean;
  customProviders?: Array<{ name: string; host?: string }>;
}) {
  const customRows = (customProviders ?? []).map(entry => ({
    value: 'openai-compatible' as Provider,
    name: entry.name,
    hint: entry.host ?? 'custom OpenAI-compatible endpoint',
  }));
  const rows: Array<{ value: Provider | typeof SAME_AS_DEEP; hint: string; name?: string }> = offerSameAsDeep
    ? [{ value: SAME_AS_DEEP, hint: 'no tiering — one model does everything' }, ...PROVIDERS, ...customRows]
    : [...PROVIDERS, ...customRows];

  const [cursor, setCursor] = useState(0);

  useInput((_, key) => {
    if (key.upArrow)   { setCursor(c => (c - 1 + rows.length) % rows.length); return; }
    if (key.downArrow) { setCursor(c => (c + 1) % rows.length); return; }
    if (key.return)    { onSelect(rows[cursor].value, rows[cursor].name); return; }
    if (key.escape)    { onBack(); return; }
  });

  return (
    <Box flexDirection="column">
      {rows.map((p, i) => {
        const active = i === cursor;
        return (
          <Box key={`${p.value}-${p.name ?? ''}-${i}`}>
            <Box flexShrink={0}>
              <Text color={active ? C.brandTo : C.faint} bold={active}>
                {active ? `${G.prompt} ` : '  '}
              </Text>
            </Box>
            <Box flexShrink={0}>
              <Text color={active ? C.brandTo : C.muted} bold={active}>{(p.name ?? p.value).padEnd(20)}</Text>
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

// ── steps ─────────────────────────────────────────────────────────────────────

type Step =
  | { name: 'provider' }
  | { name: 'endpoint-name'; provider: Provider; host: string; apiKey?: string; endpointName?: string }
  | { name: 'host'; provider: Provider; endpointName?: string }
  | { name: 'model'; provider: Provider; host?: string; apiKey?: string; endpointName?: string }
  | { name: 'custom'; provider: Provider; host?: string; apiKey?: string; endpointName?: string }
  | { name: 'key'; provider: Provider; host?: string };

export interface SetupProps {
  initial?: { provider?: Provider; model?: string; host?: string };
  /**
   * What is stored for one endpoint: its last-used host, so switching providers
   * mid-wizard re-seeds that provider's own address rather than reusing one flat
   * host, and whether it already has a key, so the key step can be confirmed
   * with a bare enter instead of retyping a secret.
   *
   * A lookup, not two maps. The wizard asks about the endpoint it is on and the
   * config layer answers; it does not get handed a table it has to key
   * correctly, which is what let named endpoints fall through to the wrong
   * entry.
   */
  credentials?: (ref: ProviderRef) => { host?: string; apiKey?: string };
  customProviders?: Array<{ name: string; host?: string }>;
  /**
   * Which tier is being chosen. `fast` gets a "same as deep" escape and
   * different framing — it is the delegation target, not the main model.
   */
  tier?: Tier;
  /** Model the deep tier is on, shown while picking `fast` for contrast. */
  deepLabel?: string;
  /**
   * Overrides the tier-based title and blurb — for a picker that isn't a model
   * tier at all, e.g. `/safety agentic`'s judge-model choice. Leaves `tier`'s
   * other behaviour (the API-key step, `onComplete`'s shape) untouched; only
   * the two lines of framing text change.
   */
  title?: string;
  blurb?: string;
  /** `model === null` means "same as deep" — clear any fast override. */
  onComplete: (provider: Provider | null, model: string | null, host?: string, apiKey?: string, name?: string) => void;
  /**
   * Cancel the wizard outright (ESC from the provider step). Returns to the
   * default chat screen instead of proceeding — how a `/model` was aborted.
   */
  onExit?: () => void;
}

/**
 * The prompt text for the API-key step.
 *
 * Extracted from the render so the one rule that matters here is testable: a
 * stored key is *never* shown, not in full and not as a hint of itself. Only
 * its existence is, and only as a changed instruction. The env var name is
 * safe — it is a name, not a value.
 *
 * The obvious "helpful" change is to echo the last four characters so the user
 * can tell which key is stored. Don't: this text is on screen during screen
 * shares and lands in terminal scrollback, and four characters is enough to
 * confirm a guessed key. The regression test pins this.
 */
export function keyStepText(envKey: string, stored?: string): { placeholder: string; hint: string } {
  return stored
    ? {
        placeholder: `${envKey} — enter keeps the stored key`,
        hint: `enter keeps the stored key ${G.bullet} type to replace it ${G.bullet} esc back`,
      }
    : {
        placeholder: `${envKey} (stored in your global config)`,
        hint: `enter confirms ${G.bullet} esc back ${G.bullet} or set ${envKey} in your environment instead`,
      };
}

/**
 * The key to proceed with, given what was typed and what is already stored.
 *
 * Typing wins, so a key can still be replaced. An empty field falls back to the
 * stored key, which is what makes a bare enter mean "keep using that one" —
 * before this, an empty submit was silently ignored and the only way past the
 * step was to retype a secret the config already held.
 *
 * Returns undefined when there is nothing to proceed with, which the caller
 * treats as "stay on this step".
 */
export function resolveKeyInput(typed: string, stored?: string): string | undefined {
  return typed.trim() || stored || undefined;
}

/**
 * Which server URL to pre-fill for `provider`.
 *
 * Prefer that provider's own last-used host, then the host we started the
 * session on, then the built-in default.
 *
 * The middle step only applies when the session's host belongs to the *same*
 * provider. It is the flat pre-tier config shape, and carrying it across a
 * switch pre-filled ollama with a llama.cpp URL — the probe then went to the
 * wrong server and the wizard reported it as unreachable.
 */
export function seedHost(
  ref: ProviderRef,
  credentials?: (ref: ProviderRef) => { host?: string },
  initial?: { provider?: Provider; host?: string },
): string {
  const providerDefault = PROVIDER_DEFAULTS[ref.provider as Provider];
  const builtIn = 'host' in providerDefault ? providerDefault.host : '';
  const sameProvider = initial?.provider === ref.provider ? initial?.host : undefined;
  return credentials?.(ref).host ?? sameProvider ?? builtIn ?? '';
}

/** What each tier is *for*, so the choice isn't guesswork. */
const TIER_BLURB: Record<Tier, string> = {
  deep: 'writes code, plans and reviews',
  fast: 'reads files, searches and summarises for the deep model',
};

export function Setup({ initial, tier = 'deep', title, blurb, deepLabel, credentials, customProviders, onComplete, onExit }: SetupProps) {
  const [step, setStep] = useState<Step>({ name: 'provider' });
  traceRender('Setup', `step=${step.name}`);
  const [hostInput, setHostInput] = useState('');
  const [endpointNameInput, setEndpointNameInput] = useState('');
  const [selectedEndpointName, setSelectedEndpointName] = useState<string | undefined>();
  const [customInput, setCustomInput] = useState('');
  const [keyInput, setKeyInput] = useState('');

  // The endpoint being configured. `name` defaults to the row the user picked
  // on the provider step, which is what makes a named endpoint look up its own
  // stored host and key; it is passed explicitly only where that state has not
  // been set yet, in the provider step's own handler.
  const refFor = (provider: Provider, name = selectedEndpointName): ProviderRef =>
    ({ provider, ...(name ? { name } : {}) });

  const defaultHostFor = (provider: Provider, name?: string): string =>
    seedHost(refFor(provider, name), credentials, initial);

  // Environment keys are already available to the session. Only prompt when
  // neither the environment nor the global saved-key selection has a value.
  const keyFor = (provider: Provider, name?: string): string | undefined => {
    const envKey = PROVIDER_DEFAULTS[provider].envKey;
    return credentials?.(refFor(provider, name)).apiKey
      || (envKey ? process.env[envKey] : undefined) || undefined;
  };
  const needsKey = (provider: Provider): boolean => Boolean(
    (provider === 'openai-compatible' || provider === 'llamacpp')
      || (PROVIDER_DEFAULTS[provider].envKey && !keyFor(provider)),
  );

  const keyIsOptional = (provider: Provider): boolean =>
    provider === 'openai-compatible' || provider === 'llamacpp';

  const enterModelStep = (provider: Provider, host?: string, apiKey?: string) => {
    if (provider === 'openai-compatible') {
      setEndpointNameInput('');
      setStep({ name: 'endpoint-name', provider, host: host ?? defaultHostFor(provider), apiKey, endpointName: selectedEndpointName });
      return;
    }
    setStep({ name: 'model', provider, host, apiKey });
  };

  const label = (rest: string) => `${title ?? `${tier} model`}  ${G.bullet}  ${rest}`;

  if (step.name === 'provider') {
    return (
      <Box flexDirection="column" gap={1}>
        <Title step={label('choose a provider')} />
        <Box flexDirection="column">
          <Hint>{blurb ?? TIER_BLURB[tier]}</Hint>
          {tier === 'fast' && deepLabel ? <Hint>{`deep model is ${deepLabel}`}</Hint> : null}
        </Box>
        <ProviderSelect
          offerSameAsDeep={tier === 'fast'}
          customProviders={customProviders}
          onBack={onExit ?? (() => {})}
          onSelect={(p, selectedName) => {
            if (p === SAME_AS_DEEP) { onComplete(null, null); return; }
            if (providerHasHost(p)) {
              setSelectedEndpointName(selectedName);
              setHostInput(defaultHostFor(p, selectedName));
              setStep({ name: 'host', provider: p, endpointName: selectedName });
            } else {
              const stored = keyFor(p);
              if (needsKey(p)) {
                setKeyInput('');
                setStep({ name: 'key', provider: p });
              } else enterModelStep(p, undefined, stored);
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
            const stored = keyFor(provider);
            if (needsKey(provider)) {
              setKeyInput('');
              setStep({ name: 'key', provider, host: h });
            } else enterModelStep(provider, h, stored);
          }}
          onBack={() => setStep({ name: 'provider' })}
        />
        <Hint>{`enter confirms ${G.bullet} esc back`}</Hint>
      </Box>
    );
  }

  if (step.name === 'endpoint-name') {
    const { provider, host, apiKey } = step;
    return (
      <Box flexDirection="column" gap={1}>
        <Title step={label(`${provider}  ${G.bullet}  endpoint name`)} />
        <BackableTextInput
          value={endpointNameInput || step.endpointName || ''}
          onChange={setEndpointNameInput}
          onSubmit={(val) => {
            const name = val.trim();
            if (name) setStep({ name: 'model', provider, host, apiKey, endpointName: name });
          }}
          onBack={() => setStep({ name: 'host', provider })}
          placeholder="e.g. LM Studio"
        />
        <Hint>{`enter confirms ${G.bullet} esc back`}</Hint>
      </Box>
    );
  }

  if (step.name === 'model') {
    const { provider, host, endpointName } = step;
    return (
      <Box flexDirection="column" gap={1}>
        <Title step={label(`${provider}  ${G.bullet}  choose a model`)} />
        <ModelSelect
          provider={provider}
          host={host ?? defaultHostFor(provider)}
          apiKey={step.apiKey}
          onSelect={(val) => {
            if (val === CUSTOM) setStep({ name: 'custom', provider, host, apiKey: step.apiKey, endpointName });
            else onComplete(provider, val, host, step.apiKey, endpointName);
          }}
          onBack={() => (providerHasHost(provider) ? setStep({ name: 'host', provider }) : setStep({ name: 'provider' }))}
        />
        <Hint>{`↑↓ move ${G.bullet} enter select ${G.bullet} ← / esc back`}</Hint>
      </Box>
    );
  }

  if (step.name === 'key') {
    const { provider, host } = step;
    const envKey = PROVIDER_DEFAULTS[provider].envKey ?? 'API key';
    const stored = keyFor(provider);
    const text = keyStepText(envKey, stored);
    return (
      <Box flexDirection="column" gap={1}>
        <Title step={label(`${provider}  ${G.bullet}  API key`)} />
        {/* `value` is the field, which starts empty and stays empty until the
            user types — the stored key is never seeded into it, so there is
            nothing for `mask` to have to hide. */}
        <BackableTextInput
          value={keyInput}
          onChange={setKeyInput}
          onSubmit={(val) => {
            const k = resolveKeyInput(val, stored);
            if (k || keyIsOptional(provider)) enterModelStep(provider, host, k);
          }}
          // Only hosted providers reach the key step, and they have no host
          // step — the screen before this one is the provider select.
          onBack={() => setStep({ name: 'provider' })}
          placeholder={text.placeholder}
          mask="*"
        />
        <Hint>{text.hint}</Hint>
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
          if (m) onComplete(provider, m, host, step.apiKey, step.endpointName);
        }}
        onBack={() => setStep({ name: 'model', provider, host, apiKey: step.apiKey, endpointName: step.endpointName })}
        placeholder={PROVIDER_DEFAULTS[provider].model}
      />
      <Hint>{`enter confirms ${G.bullet} esc back`}</Hint>
    </Box>
  );
}
