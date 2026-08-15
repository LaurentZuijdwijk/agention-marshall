import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { C, G } from '../theme.js';
import { Title, Hint } from '../WizardChrome.js';
import { ProviderMenu, type ProviderEntry } from './ProviderMenu.js';
import { McpMenu } from './McpMenu.js';
import type { McpServerConfig } from '@agentionai/marshall-engine';
import type { RuntimeMode } from '../../services/settings.js';
import type { SafetyLevel } from '@agentionai/marshall-engine';

export interface SettingsMenuProps {
  scope: 'project' | 'global';
  runtime: RuntimeMode;
  safetyLevel: SafetyLevel;
  deepModel: { provider: string; model?: string };
  fastModel?: { provider: string; model?: string };
  providers: ProviderEntry[];
  mcpServers: McpServerConfig[];
  onMcpAdd: () => void;
  onMcpRemove: (server: McpServerConfig) => void;
  onProviderAdd: () => void;
  onProviderRemove: (entry: ProviderEntry) => void;
  onRuntimeChange: (mode: RuntimeMode, scope: 'project' | 'global') => void;
  onSafetyChange: (level: SafetyLevel) => void;
  onModels: (tier: 'deep' | 'fast') => void;
  onUpdate: () => void;
  onExit: () => void;
}

type Page = 'root' | 'runtime' | 'safety' | 'models' | 'providers' | 'mcp';

const ROOT_ITEMS = [
  ['Runtime', 'Choose the tool belt mode'],
  ['Safety', 'Choose who approves tool calls'],
  ['Models', 'Configure deep and fast models'],
  ['Providers', 'List, add, or remove providers'],
  ['MCP', 'Connect external tool servers'],
  ['Update', 'Check for a newer version'],
] as const;
const RUNTIME_ITEMS: RuntimeMode[] = ['default', 'light', 'agentic'];
const MODEL_ITEMS = [
  { tier: 'deep' as const, label: 'Deep model', hint: 'primary reasoning model' },
  { tier: 'fast' as const, label: 'Fast model', hint: 'lightweight delegated work' },
];
const SAFETY_ITEMS: Array<{ level: SafetyLevel; label: string; hint: string }> = [
  { level: 1, label: 'Yolo', hint: 'session only; no approval gate' },
  { level: 2, label: 'Default', hint: 'you approve state-changing calls' },
  { level: 3, label: 'Agentic', hint: 'judge reviews calls before you do' },
];

export function SettingsMenu({
  scope, runtime, safetyLevel, deepModel, fastModel, providers, mcpServers, onMcpAdd, onMcpRemove, onProviderAdd, onProviderRemove, onRuntimeChange, onSafetyChange, onModels, onUpdate, onExit,
}: SettingsMenuProps) {
  const [page, setPage] = useState<Page>('root');
  const [cursor, setCursor] = useState(0);
  const itemsLength = page === 'root' ? ROOT_ITEMS.length : page === 'runtime' ? RUNTIME_ITEMS.length : page === 'safety' ? SAFETY_ITEMS.length : page === 'models' ? MODEL_ITEMS.length : 0;

  const back = () => {
    if (page === 'root') onExit();
    else { setPage('root'); setCursor(0); }
  };
  const select = () => {
    if (page === 'root') {
      if (cursor === 0) setPage('runtime');
      else if (cursor === 1) setPage('safety');
      else if (cursor === 2) setPage('models');
      else if (cursor === 3) setPage('providers');
      else if (cursor === 4) setPage('mcp');
      else onUpdate();
      setCursor(0);
    } else if (page === 'runtime') {
      onRuntimeChange(RUNTIME_ITEMS[cursor], scope);
      setPage('root'); setCursor(0);
    } else if (page === 'safety') {
      onSafetyChange(SAFETY_ITEMS[cursor].level);
      setPage('root'); setCursor(0);
    } else {
      onModels(MODEL_ITEMS[cursor].tier);
    }
  };

  useInput((ch, key) => {
    // Child menus own input handling while mounted. Do not let this root
    // handler interpret their Enter/Escape events as settings selections.
    if (page === 'providers' || page === 'mcp') return;
    if (key.upArrow) setCursor(c => (c - 1 + itemsLength) % itemsLength);
    else if (key.downArrow) setCursor(c => (c + 1) % itemsLength);
    else if (key.return) select();
    else if (key.escape || key.leftArrow || ch === '\u001b') back();
  });

  if (page === 'providers') {
    return <ProviderMenu providers={providers} onAdd={onProviderAdd} onRemove={onProviderRemove} onBack={() => { setPage('root'); setCursor(0); }} />;
  }
  if (page === 'mcp') {
    return <McpMenu servers={mcpServers} onAdd={onMcpAdd} onRemove={onMcpRemove} onBack={() => { setPage('root'); setCursor(0); }} />;
  }

  const title = page === 'root' ? 'settings' : page;
  return (
    <Box flexDirection="column">
      <Title step={title} />
      <Text color={C.faint}>scope: {scope === 'global' ? 'global' : 'local/project'}</Text>
      <Hint>{page === 'root' ? 'choose a category' : 'choose a value'} · ↑↓ navigate · enter select · esc back</Hint>
      <Box flexDirection="column" marginTop={1}>
        {page === 'root' && ROOT_ITEMS.map(([label, hint], index) => (
          <Row key={label} active={index === cursor} label={label} hint={hint} />
        ))}
        {page === 'runtime' && RUNTIME_ITEMS.map((value, index) => (
          <Row key={value} active={index === cursor} selected={value === runtime} label={value} hint={value === runtime ? 'current' : undefined} />
        ))}
        {page === 'safety' && SAFETY_ITEMS.map((item, index) => (
          <Row key={item.label} active={index === cursor} selected={item.level === safetyLevel} label={item.label} hint={item.level === safetyLevel ? `${item.hint}; current` : item.hint} />
        ))}
        {page === 'models' && MODEL_ITEMS.map((item, index) => {
          const profile = item.tier === 'deep' ? deepModel : fastModel;
          const model = profile ? `${profile.provider}/${profile.model ?? 'default'}` : 'not configured';
          return <Row key={item.tier} active={index === cursor} label={item.label} hint={`${model} · ${item.hint}`} />;
        })}
      </Box>
    </Box>
  );
}

function Row({ active, selected, label, hint }: { active: boolean; selected?: boolean; label: string; hint?: string }) {
  return (
    <Box>
      <Text color={active ? C.brandTo : selected ? C.ok : C.faint} bold={active}>{active ? `${G.prompt} ` : selected ? `${G.ok} ` : '  '}</Text>
      <Text color={active ? C.brandTo : C.muted} bold={active}>{label}</Text>
      {hint && <Text color={selected && !active ? C.ok : C.faint}>  {hint}</Text>}
    </Box>
  );
}
