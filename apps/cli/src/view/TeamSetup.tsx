// ── add a named agent ────────────────────────────────────────────────────────
//
// name → provider → model → description, the same one-question-at-a-time
// shape as McpSetup. Provider and model reuse Setup's own pickers rather than
// duplicating them — a named agent picks from the same catalogue a tier does,
// it just never asks for a host or a key: those are resolved from whatever
// the global config already has for that provider when the agent actually
// runs (see `toNamedAgents`), the same split `/model` uses.

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { PROVIDER_DEFAULTS } from '@agentionai/marshall-engine';
import type { AgentToolset, Provider } from '@agentionai/marshall-engine';
import type { ProviderRef, SavedAgentEntry } from '../services/config-store.js';
import { C, G } from './theme.js';
import { Title, Hint, BackableTextInput } from './WizardChrome.js';
import { ProviderSelect, seedHost } from './Setup.js';
import { CUSTOM, ModelSelect } from './ModelPicker.js';
import { providerHasHost } from '../services/modelCatalog.js';

type Step =
  | { name: 'name' }
  | { name: 'provider' }
  | { name: 'model'; provider: Provider; host: string; apiKey?: string }
  | { name: 'custom-model'; provider: Provider }
  | { name: 'toolset'; provider: Provider; model: string }
  | { name: 'description'; provider: Provider; model: string };

const TOOLSET_OPTIONS: Array<{ value: AgentToolset | undefined; label: string; hint: string }> = [
  { value: undefined, label: 'ask each time', hint: 'the coder picks a toolset per spawn, same as an agent spawned by tier' },
  { value: 'readonly', label: 'readonly', hint: 'investigate only — read, list, search' },
  { value: 'edit', label: 'edit', hint: 'readonly, plus write and edit files' },
  { value: 'full', label: 'full', hint: 'edit, plus run commands' },
];

export interface TeamSetupProps {
  /** Names already defined — adding one that matches replaces it, so this is
   *  shown as a note rather than a hard block (see `/team add`). */
  existing: string[];
  /** Same lookup `Setup` uses, for a live model list. A named agent stores no
   *  credential of its own; this only ever powers the picker. */
  credentials?: (ref: ProviderRef) => { host?: string; apiKey?: string };
  onComplete(entry: SavedAgentEntry): void;
  onExit(): void;
}

export function TeamSetup({ existing, credentials, onComplete, onExit }: TeamSetupProps) {
  const [step, setStep] = useState<Step>({ name: 'name' });
  const [nameInput, setNameInput] = useState('');
  const [name, setName] = useState('');
  const [customModelInput, setCustomModelInput] = useState('');
  const [toolset, setToolset] = useState<AgentToolset | undefined>(undefined);
  const [toolsetCursor, setToolsetCursor] = useState(0);
  const [descriptionInput, setDescriptionInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  const label = (rest: string) => `add an agent  ${G.bullet}  ${rest}`;

  const hostFor = (provider: Provider): string => seedHost({ provider }, credentials);
  const apiKeyFor = (provider: Provider): string | undefined => credentials?.({ provider }).apiKey;

  // Scoped to the `toolset` step alone — every other step's keys are handled
  // by whichever child owns that step (`BackableTextInput`, `ProviderSelect`,
  // `ModelSelect`), the same division McpSetup's own `scope` step keeps.
  useInput((_, key) => {
    if (step.name !== 'toolset') return;
    if (key.upArrow) {
      setToolsetCursor(c => (c - 1 + TOOLSET_OPTIONS.length) % TOOLSET_OPTIONS.length);
      return;
    }
    if (key.downArrow) {
      setToolsetCursor(c => (c + 1) % TOOLSET_OPTIONS.length);
      return;
    }
    if (key.return) {
      setToolset(TOOLSET_OPTIONS[toolsetCursor].value);
      setStep({ name: 'description', provider: step.provider, model: step.model });
      return;
    }
    if (key.escape) {
      setStep({ name: 'model', provider: step.provider, host: hostFor(step.provider), apiKey: apiKeyFor(step.provider) });
    }
  });

  const submitName = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
      setError('Letters, numbers, dash and underscore only — the coder types this to delegate to it.');
      return;
    }
    setError(null);
    setName(trimmed);
    setStep({ name: 'provider' });
  };

  if (step.name === 'name') {
    return (
      <Box flexDirection="column" gap={1}>
        <Title step={label('name')} />
        <Hint>what the coder will call it when delegating a task</Hint>
        <BackableTextInput
          value={nameInput}
          onChange={setNameInput}
          onSubmit={submitName}
          onBack={onExit}
          placeholder="tester"
        />
        {existing.includes(nameInput.trim()) && (
          <Hint>{`replaces the existing "${nameInput.trim()}" agent`}</Hint>
        )}
        {error && <Text color={C.error}>{G.err} {error}</Text>}
        <Hint>{`enter continues ${G.bullet} esc cancels`}</Hint>
      </Box>
    );
  }

  if (step.name === 'provider') {
    return (
      <Box flexDirection="column" gap={1}>
        <Title step={label(`${name}  ${G.bullet}  provider`)} />
        <ProviderSelect
          onBack={() => setStep({ name: 'name' })}
          onSelect={(p) => {
            const provider = p as Provider;
            const host = hostFor(provider);
            // Nothing to probe: this provider needs a server address and none
            // is configured globally yet, so go straight to typing the model
            // id rather than asking `ModelSelect` to discover against ''.
            if (providerHasHost(provider) && !host) {
              setStep({ name: 'custom-model', provider });
            } else {
              setStep({ name: 'model', provider, host, apiKey: apiKeyFor(provider) });
            }
          }}
        />
        <Hint>{`↑↓ move ${G.bullet} enter select ${G.bullet} esc back`}</Hint>
      </Box>
    );
  }

  if (step.name === 'model') {
    const { provider, host, apiKey } = step;
    return (
      <Box flexDirection="column" gap={1}>
        <Title step={label(`${name}  ${G.bullet}  ${provider}  ${G.bullet}  model`)} />
        <ModelSelect
          provider={provider}
          host={host}
          apiKey={apiKey}
          onSelect={(val) => {
            if (val === CUSTOM) setStep({ name: 'custom-model', provider });
            else setStep({ name: 'toolset', provider, model: val });
          }}
          onBack={() => setStep({ name: 'provider' })}
        />
        <Hint>{`↑↓ move ${G.bullet} enter select ${G.bullet} ← / esc back`}</Hint>
      </Box>
    );
  }

  if (step.name === 'custom-model') {
    const { provider } = step;
    return (
      <Box flexDirection="column" gap={1}>
        <Title step={label(`${name}  ${G.bullet}  ${provider}  ${G.bullet}  model id`)} />
        <BackableTextInput
          value={customModelInput}
          onChange={setCustomModelInput}
          onSubmit={(val) => {
            const model = val.trim();
            if (!model) return;
            setCustomModelInput('');
            setStep({ name: 'toolset', provider, model });
          }}
          onBack={() => setStep({ name: 'provider' })}
          placeholder={PROVIDER_DEFAULTS[provider].model}
        />
        <Hint>{`enter confirms ${G.bullet} esc back`}</Hint>
      </Box>
    );
  }

  if (step.name === 'toolset') {
    const { provider, model } = step;
    return (
      <Box flexDirection="column" gap={1}>
        <Title step={label(`${name}  ${G.bullet}  ${provider}/${model}  ${G.bullet}  toolset`)} />
        <Hint>what it may do — fixed for this agent, or left for the coder to choose at every spawn</Hint>
        <Box flexDirection="column">
          {TOOLSET_OPTIONS.map((option, i) => (
            <ToolsetChoice key={option.label} active={i === toolsetCursor} label={option.label} hint={option.hint} />
          ))}
        </Box>
        <Hint>{`↑↓ choose ${G.bullet} enter confirms ${G.bullet} esc back`}</Hint>
      </Box>
    );
  }

  // description
  const { provider, model } = step;
  return (
    <Box flexDirection="column" gap={1}>
      <Title step={label(`${name}  ${G.bullet}  ${provider}/${model}  ${G.bullet}  description`)} />
      <Hint>what this agent is for — shown to the coder when it decides whether to delegate</Hint>
      <BackableTextInput
        value={descriptionInput}
        onChange={setDescriptionInput}
        onSubmit={(val) => {
          const description = val.trim();
          onComplete({ name, provider, model, ...(toolset ? { toolset } : {}), ...(description ? { description } : {}) });
        }}
        onBack={() => setStep({ name: 'toolset', provider, model })}
        placeholder="writes and runs unit tests"
      />
      <Hint>{`enter confirms, empty for none ${G.bullet} esc back`}</Hint>
    </Box>
  );
}

function ToolsetChoice({ active, label, hint }: { active: boolean; label: string; hint: string }) {
  return (
    <Box>
      <Text color={active ? C.accent : C.faint}>{active ? G.prompt : ' '} </Text>
      <Text color={active ? C.text : C.muted}>{label}</Text>
      <Text color={C.faint}>  {hint}</Text>
    </Box>
  );
}
