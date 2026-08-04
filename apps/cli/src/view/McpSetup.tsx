import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from './TextInput.js';
import { C, G } from './theme.js';
import type { McpServerConfig } from '@agentionai/marshall-engine';

// ── add an MCP server ─────────────────────────────────────────────────────────
//
// Four questions, asked one at a time rather than as a form: each one's answer
// feeds the next (the suggested name comes from the URL's host), and a
// single-field step is the only shape that works with a raw-mode line editor.
//
// The scope step exists because the alternative is worse than a keypress: a
// personal server added once would otherwise be attached to every unrelated
// checkout, with its tools in the prompt and its credentials in play. Project
// is the default for that reason.

type Step = 'url' | 'name' | 'token' | 'scope';

/** Where the server should be available once it works. */
export type McpScope = 'global' | 'project';

export interface McpSetupProps {
  /** Names already taken — adding a duplicate would silently replace it. */
  existing: string[];
  onComplete(server: McpServerConfig, scope: McpScope): void;
  onExit(): void;
}

/** A sensible local name from the URL, so the common case is one keypress. */
export function suggestName(url: string): string {
  try {
    const host = new URL(url).hostname;
    // `mcp.linear.app` → `linear`: drop a leading `mcp.`, then the public suffix,
    // which leaves the part anyone would actually call the server.
    const parts = host.replace(/^mcp\./, '').split('.');
    const stem = parts.length > 1 ? parts[parts.length - 2]! : parts[0]!;
    return stem.replace(/[^a-zA-Z0-9_-]/g, '_');
  } catch {
    return '';
  }
}

/** Rejected before we try to connect — a clear message beats a socket error. */
export function validateUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'That is not a valid URL — include the scheme, e.g. https://mcp.example.com/mcp';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `Only http and https are supported here — got "${parsed.protocol.replace(':', '')}".`;
  }
  if (parsed.protocol === 'http:' && !isLoopback(parsed.hostname)) {
    return 'Refusing plain http to a remote host — the auth token would go over the wire in clear.';
  }
  return null;
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

export function McpSetup({ existing, onComplete, onExit }: McpSetupProps) {
  const [step, setStep] = useState<Step>('url');
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [scope, setScope] = useState<McpScope>('project');
  const [error, setError] = useState<string | null>(null);

  useInput((_, key) => {
    if (step === 'scope' && (key.upArrow || key.downArrow)) {
      setScope(scope === 'project' ? 'global' : 'project');
      return;
    }
    if (step === 'scope' && key.return) {
      onComplete(server(), scope);
      return;
    }
    if (!key.escape) return;
    if (step === 'url') onExit();
    else setStep(BACK[step]);
  });

  const server = (): McpServerConfig => ({
    name,
    url,
    ...(token.trim() ? { headers: { Authorization: `Bearer ${token.trim()}` } } : {}),
  });

  const submitUrl = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const problem = validateUrl(trimmed);
    if (problem) { setError(problem); return; }
    setError(null);
    setUrl(trimmed);
    if (!name) setName(suggestName(trimmed));
    setStep('name');
  };

  const submitName = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (existing.includes(trimmed)) {
      setError(`"${trimmed}" already exists — pick another name, or /mcp remove it first.`);
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
      setError('Letters, numbers, dash and underscore only — the name becomes part of each tool name.');
      return;
    }
    setError(null);
    setName(trimmed);
    setStep('token');
  };

  // Empty is a real answer here: plenty of servers need no auth at all.
  const submitToken = () => setStep('scope');

  return (
    <Box flexDirection="column">
      <Text color={C.accent} bold>add an MCP server</Text>

      {step !== 'url' && <Done label="url" value={url} />}
      {(step === 'token' || step === 'scope') && <Done label="name" value={name} />}

      <Box marginTop={1}>
        <Text color={C.muted}>{PROMPTS[step]}  </Text>
        {step === 'url' && (
          <TextInput value={url} placeholder="https://mcp.example.com/mcp" onChange={setUrl} onSubmit={submitUrl} />
        )}
        {step === 'name' && (
          <TextInput value={name} placeholder="linear" onChange={setName} onSubmit={submitName} />
        )}
        {step === 'token' && (
          <TextInput value={token} mask="•" placeholder="(none)" onChange={setToken} onSubmit={submitToken} />
        )}
      </Box>

      {step === 'scope' && (
        <Box flexDirection="column" marginTop={1}>
          <Choice on={scope === 'project'} label="this project only"
                  hint="listed in .marshall/config.json — safe to commit" />
          <Choice on={scope === 'global'} label="every project"
                  hint="on by default wherever you run marshall" />
        </Box>
      )}

      {error && (
        <Box marginTop={1}>
          <Text color={C.error}>{G.err} {error}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={C.faint}>{HINTS[step]}</Text>
      </Box>
    </Box>
  );
}

/** Where escape goes from each step. */
const BACK: Record<Exclude<Step, 'url'>, Step> = {
  name:  'url',
  token: 'name',
  scope: 'token',
};

const PROMPTS: Record<Step, string> = {
  url:   'server url',
  name:  'local name',
  token: 'auth token',
  scope: 'available in',
};

const HINTS: Record<Step, string> = {
  url:   `enter continues ${G.bullet} esc cancels`,
  name:  `names the tools (mcp__name__tool) ${G.bullet} esc goes back`,
  token: `sent as an Authorization: Bearer header ${G.bullet} enter with none to skip ${G.bullet} esc goes back`,
  scope: `↑↓ choose ${G.bullet} enter confirms ${G.bullet} esc goes back`,
};

function Choice({ on, label, hint }: { on: boolean; label: string; hint: string }) {
  return (
    <Box>
      <Text color={on ? C.accent : C.faint}>{on ? G.prompt : ' '} </Text>
      <Text color={on ? C.text : C.muted}>{label}</Text>
      <Text color={C.faint}>  {hint}</Text>
    </Box>
  );
}

function Done({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Text color={C.ok}>{G.ok} </Text>
      <Text color={C.muted}>{label}  </Text>
      <Text color={C.text}>{value}</Text>
    </Box>
  );
}
