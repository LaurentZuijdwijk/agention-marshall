// ── setup wizard ──────────────────────────────────────────────────────────────
//
// The provider → host → key → model walk, and nothing else: discovery lives in
// services/modelCatalog, the picker in ModelPicker, the frame in WizardChrome.

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { PROVIDER_DEFAULTS } from '@agentionai/marshall-engine';
import type { Provider, Tier } from '@agentionai/marshall-engine';
import { C, G } from './theme.js';
import { Title, Hint, BackableTextInput } from './WizardChrome.js';
import { CUSTOM, ModelSelect } from './ModelPicker.js';
import { PROVIDERS, providerHasHost } from '../services/modelCatalog.js';
import { traceRender } from '../renderTrace.js';

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

// ── steps ─────────────────────────────────────────────────────────────────────

type Step =
  | { name: 'provider' }
  | { name: 'host'; provider: Provider }
  | { name: 'model'; provider: Provider; host?: string; apiKey?: string }
  | { name: 'custom'; provider: Provider; host?: string; apiKey?: string }
  | { name: 'key'; provider: Provider; host?: string };

export interface SetupProps {
  initial?: { provider?: Provider; model?: string; host?: string };
  /**
   * Last-used host per provider (from the config `providers` array). When the
   * user switches providers mid-wizard, the host field re-seeds to that
   * provider's own saved host rather than reusing one flat host.
   */
  savedHosts?: Record<Provider, string | undefined>;
  /** Stored API key per provider. Presence is what lets the key step be
   *  confirmed with a bare enter instead of retyping a secret. */
  savedKeys?: Record<string, string | undefined>;
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
  onComplete: (provider: Provider | null, model: string | null, host?: string, apiKey?: string) => void;
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
  provider: Provider,
  savedHosts?: Record<string, string | undefined>,
  initial?: { provider?: Provider; host?: string },
): string {
  const providerDefault = PROVIDER_DEFAULTS[provider];
  const builtIn = 'host' in providerDefault ? providerDefault.host : '';
  const sameProvider = initial?.provider === provider ? initial?.host : undefined;
  return savedHosts?.[provider] ?? sameProvider ?? builtIn ?? '';
}

/** What each tier is *for*, so the choice isn't guesswork. */
const TIER_BLURB: Record<Tier, string> = {
  deep: 'writes code, plans and reviews',
  fast: 'reads files, searches and summarises for the deep model',
};

export function Setup({ initial, tier = 'deep', title, blurb, deepLabel, savedHosts, savedKeys, onComplete, onExit }: SetupProps) {
  const [step, setStep] = useState<Step>({ name: 'provider' });
  traceRender('Setup', `step=${step.name}`);
  const [hostInput, setHostInput] = useState('');
  const [customInput, setCustomInput] = useState('');
  const [keyInput, setKeyInput] = useState('');

  const defaultHostFor = (provider: Provider): string => seedHost(provider, savedHosts, initial);

  // Environment keys are already available to the session. Only prompt when
  // neither the environment nor the global saved-key selection has a value.
  const keyFor = (provider: Provider): string | undefined => {
    const envKey = PROVIDER_DEFAULTS[provider].envKey;
    return savedKeys?.[provider] || (envKey ? process.env[envKey] : undefined) || undefined;
  };
  const needsKey = (provider: Provider): boolean => Boolean(
    PROVIDER_DEFAULTS[provider].envKey && !keyFor(provider),
  );

  const enterModelStep = (provider: Provider, host?: string, apiKey?: string) => {
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
          onBack={onExit ?? (() => {})}
          onSelect={(p) => {
            if (p === SAME_AS_DEEP) { onComplete(null, null); return; }
            if (providerHasHost(p)) {
              setHostInput(defaultHostFor(p));
              setStep({ name: 'host', provider: p });
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

  if (step.name === 'model') {
    const { provider, host } = step;
    return (
      <Box flexDirection="column" gap={1}>
        <Title step={label(`${provider}  ${G.bullet}  choose a model`)} />
        <ModelSelect
          provider={provider}
          host={host ?? defaultHostFor(provider)}
          apiKey={step.apiKey}
          onSelect={(val) => {
            if (val === CUSTOM) setStep({ name: 'custom', provider, host, apiKey: step.apiKey });
            else onComplete(provider, val, host, step.apiKey);
          }}
          onBack={() => (providerHasHost(provider) ? setStep({ name: 'host', provider }) : setStep({ name: 'provider' }))}
        />
        <Hint>{`↑↓ move ${G.bullet} enter select ${G.bullet} ← / esc back`}</Hint>
      </Box>
    );
  }

  if (step.name === 'key') {
    const { provider, host } = step;
    const envKey = PROVIDER_DEFAULTS[provider].envKey!;
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
            if (k) enterModelStep(provider, host, k);
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
          if (m) onComplete(provider, m, host, step.apiKey);
        }}
        onBack={() => setStep({ name: 'model', provider, host, apiKey: step.apiKey })}
        placeholder={PROVIDER_DEFAULTS[provider].model}
      />
      <Hint>{`enter confirms ${G.bullet} esc back`}</Hint>
    </Box>
  );
}
