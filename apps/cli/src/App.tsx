import React, { useRef, useState, useMemo } from 'react';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Box, Text, Static, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { Session } from '@marshall/engine';
import type { AgentProfile, OutputEvent, ClientInterface } from '@marshall/engine';
import type { ApprovalRequest, ApprovalDecision } from '@marshall/tools';

// ── types ─────────────────────────────────────────────────────────────────────

type MessageRole = 'system' | 'user' | 'assistant' | 'tool' | 'info' | 'error';

interface Message {
  key: string;
  role: MessageRole;
  content: string;
}

type Mode =
  | { type: 'idle' }
  | { type: 'running' }
  | { type: 'approval'; request: ApprovalRequest };

// ── help text ──────────────────────────────────────────────────────────────────

const HELP = `commands:
  /help    — show this message
  /clear   — clear history, dedupe cache, and scratch notes
  /cwd     — show workspace path
  /memory  — view AGENTS.md (project memory)
  /exit    — quit

Esc              — interrupt running task (enters steering mode)
Esc Esc          — force-quit
Esc (approval)   — deny all pending and interrupt`;

// ── approval select ────────────────────────────────────────────────────────────

const APPROVAL_OPTIONS: Array<{ label: string; hint: string; value: ApprovalDecision }> = [
  { label: 'Approve',                    hint: 'y', value: 'approve' },
  { label: 'Always approve this tool',   hint: 'a', value: 'always'  },
  { label: 'Deny',                       hint: 'n', value: 'deny'    },
];

function ApprovalSelect({ onSelect }: { onSelect: (d: ApprovalDecision) => void }) {
  const [cursor, setCursor] = useState(0);

  useInput((ch, key) => {
    if (key.upArrow)   { setCursor(c => (c - 1 + APPROVAL_OPTIONS.length) % APPROVAL_OPTIONS.length); return; }
    if (key.downArrow) { setCursor(c => (c + 1) % APPROVAL_OPTIONS.length); return; }
    if (key.return)    { onSelect(APPROVAL_OPTIONS[cursor].value); return; }
    // Quick single-key shortcuts
    if (ch === 'y')    { onSelect('approve'); return; }
    if (ch === 'a')    { onSelect('always');  return; }
    if (ch === 'n')    { onSelect('deny');    return; }
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      {APPROVAL_OPTIONS.map((opt, i) => (
        <Box key={opt.value}>
          <Text color={i === cursor ? 'yellowBright' : undefined} bold={i === cursor}>
            {i === cursor ? '❯ ' : '  '}
          </Text>
          <Text color={i === cursor ? 'yellowBright' : 'gray'}>
            {opt.label}
          </Text>
          <Text dimColor>  {opt.hint}</Text>
        </Box>
      ))}
      <Box marginTop={1}>
        <Text dimColor>↑↓ move · enter select · esc deny all and interrupt</Text>
      </Box>
    </Box>
  );
}

// ── main component ─────────────────────────────────────────────────────────────

interface AppProps {
  workspaceRoot: string;
  agentProfile: AgentProfile;
  enableGitHub?: boolean;
}

export function App({ workspaceRoot, agentProfile, enableGitHub = false }: AppProps) {
  const { exit } = useApp();
  const counter = useRef(0);
  const makeKey = () => String(++counter.current);

  const [messages, setMessages] = useState<Message[]>([
    {
      key: makeKey(),
      role: 'system',
      content: `${agentProfile.provider}/${agentProfile.model ?? 'default'}  ${workspaceRoot}`,
    },
  ]);
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<Mode>({ type: 'idle' });
  const [steering, setSteering] = useState(false);

  // Queue of pending approvals — multiple tools can request approval
  // simultaneously (parallel tool use). We show them one at a time and chain.
  interface PendingApproval {
    request: ApprovalRequest;
    resolve: (d: ApprovalDecision) => void;
  }
  const approvalQueue = useRef<PendingApproval[]>([]);

  const pushRef = useRef<(role: MessageRole, content: string) => void>(() => {});
  const setSteeringRef = useRef(setSteering);
  setSteeringRef.current = setSteering;

  const push = (role: MessageRole, content: string) => {
    setMessages(prev => [...prev, { key: makeKey(), role, content }]);
  };
  pushRef.current = push;

  // ── engine client ──────────────────────────────────────────────────────────
  const client = useMemo((): ClientInterface => ({
    onOutput(event: OutputEvent) {
      switch (event.type) {
        case 'thinking':
          break;
        case 'tool-call':
          pushRef.current('tool', `${event.toolName}  ${JSON.stringify(event.input ?? {}).slice(0, 120)}`);
          break;
        case 'response':
          pushRef.current('assistant', event.text);
          setSteeringRef.current(false);
          setMode({ type: 'idle' });
          break;
        case 'usage':
          pushRef.current('info', `↑${event.inputTokens}  ↓${event.outputTokens} tokens`);
          break;
        case 'error':
          pushRef.current('error', event.message);
          setSteeringRef.current(false);
          setMode({ type: 'idle' });
          break;
        case 'interrupted':
          pushRef.current('info', 'interrupted — steer with a new instruction, or /clear to reset');
          setSteeringRef.current(true);
          setMode({ type: 'idle' });
          break;
      }
    },
    requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
      return new Promise((resolve) => {
        const wasEmpty = approvalQueue.current.length === 0;
        approvalQueue.current.push({ request, resolve });
        if (wasEmpty) setMode({ type: 'approval', request });
      });
    },
  }), []); // eslint-disable-line react-hooks/exhaustive-deps

  const session = useMemo(
    () => new Session({ agent: agentProfile, workspaceRoot, enableGitHub }, client),
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ── Esc handler ────────────────────────────────────────────────────────────
  const lastEsc = useRef(0);
  useInput((_, key) => {
    if (!key.escape) return;
    const now = Date.now();

    if (mode.type === 'running') {
      session.interrupt();

    } else if (mode.type === 'approval') {
      const queue = approvalQueue.current.splice(0);
      if (queue.length > 0) {
        pushRef.current('info',
          queue.length > 1
            ? `✗ denied ${queue.length} actions (interrupted)`
            : '✗ denied (interrupted)',
        );
        queue.forEach(item => item.resolve('deny'));
      }
      session.interrupt();
      setMode({ type: 'running' });

    } else if (now - lastEsc.current < 500) {
      exit();
    }

    lastEsc.current = now;
  });

  // ── resolve an approval decision ───────────────────────────────────────────
  const resolveApproval = (decision: ApprovalDecision) => {
    const item = approvalQueue.current.shift();
    if (!item) return;

    const labels: Record<ApprovalDecision, string> = {
      approve: '✓ approved',
      always:  '✓ approved (always)',
      deny:    '✗ denied',
    };
    push('info', labels[decision]);
    item.resolve(decision);

    if (approvalQueue.current.length > 0) {
      setMode({ type: 'approval', request: approvalQueue.current[0].request });
    } else {
      setMode({ type: 'running' });
    }
  };

  // ── slash commands ─────────────────────────────────────────────────────────
  const handleSlash = (cmd: string): boolean => {
    switch (cmd) {
      case '/help':  push('info', HELP); return true;
      case '/exit':  exit(); return true;
      case '/cwd':     push('info', workspaceRoot); return true;
      case '/memory': {
        const memPath = join(workspaceRoot, 'AGENTS.md');
        if (!existsSync(memPath)) {
          push('info', 'No AGENTS.md found. Create one in the workspace root to give the agent persistent context.');
        } else {
          readFile(memPath, 'utf8').then(content => push('info', content)).catch(() => push('error', 'Could not read AGENTS.md'));
        }
        return true;
      }
      case '/clear':
        approvalQueue.current.splice(0).forEach(item => item.resolve('deny'));
        session.clear().then((summary) => {
          process.stdout.write('\x1Bc');
          counter.current = 0;
          setMessages([
            {
              key: makeKey(),
              role: 'system',
              content: `${agentProfile.provider}/${agentProfile.model ?? 'default'}  ${workspaceRoot}`,
            },
            { key: makeKey(), role: 'info', content: summary },
          ]);
          setSteering(false);
        });
        return true;
    }
    return false;
  };

  // ── task submit ────────────────────────────────────────────────────────────
  const handleSubmit = (value: string) => {
    const text = value.trim();
    setInput('');
    if (!text) return;

    if (text.startsWith('/')) {
      const cmd = text.split(' ')[0];
      if (!handleSlash(cmd)) push('error', `unknown command: ${cmd} — type /help`);
      return;
    }

    push('user', text);
    setSteering(false);
    setMode({ type: 'running' });
    session.run(text).catch((err) => {
      push('error', err instanceof Error ? err.message : String(err));
      setMode({ type: 'idle' });
    });
  };

  // ── render ─────────────────────────────────────────────────────────────────
  const isApproval = mode.type === 'approval';
  const approvalReq = isApproval ? (mode as { type: 'approval'; request: ApprovalRequest }).request : null;

  return (
    <Box flexDirection="column">
      <Static items={messages}>
        {(msg) => <MessageRow key={msg.key} msg={msg} />}
      </Static>

      {isApproval && approvalReq && (
        <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginY={1}>
          <Box>
            <Text color="yellow" bold>approval required</Text>
            {approvalQueue.current.length > 1 && (
              <Text dimColor>  ({approvalQueue.current.length} pending)</Text>
            )}
          </Box>
          <Text dimColor>{approvalReq.toolName}: {approvalReq.description}</Text>
          <Box marginTop={1} flexDirection="column">
            {approvalReq.detail.split('\n').slice(0, 20).map((line, i) => (
              <Text key={i} dimColor>{line}</Text>
            ))}
            {approvalReq.detail.split('\n').length > 20 && (
              <Text dimColor>[...{approvalReq.detail.split('\n').length - 20} more lines]</Text>
            )}
          </Box>
          <ApprovalSelect onSelect={resolveApproval} />
        </Box>
      )}

      {mode.type === 'running' && (
        <Box>
          <Text color="blueBright" dimColor>thinking…</Text>
        </Box>
      )}

      {mode.type === 'idle' && (
        <Box>
          <Text color={steering ? 'yellow' : 'greenBright'} bold>
            {steering ? '↪ ' : '❯ '}
          </Text>
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={handleSubmit}
            placeholder={steering ? 'steer the agent…' : 'type a task or /help…'}
          />
        </Box>
      )}
    </Box>
  );
}

// ── message row ────────────────────────────────────────────────────────────────

function MessageRow({ msg }: { msg: Message }) {
  switch (msg.role) {
    case 'system':
      return (
        <Box marginBottom={1}>
          <Text bold color="cyanBright">marshall  </Text>
          <Text dimColor>{msg.content}</Text>
        </Box>
      );
    case 'user':
      return (
        <Box>
          <Text color="greenBright" bold>you    </Text>
          <Text>{msg.content}</Text>
        </Box>
      );
    case 'assistant':
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="blueBright" bold>ai</Text>
          {msg.content.split('\n').map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
        </Box>
      );
    case 'tool':
      return (
        <Box>
          <Text color="magentaBright" dimColor>→  </Text>
          <Text dimColor>{msg.content}</Text>
        </Box>
      );
    case 'info':
      return (
        <Box flexDirection="column">
          {msg.content.split('\n').map((line, i) => (
            <Text key={i} color="yellow">{line}</Text>
          ))}
        </Box>
      );
    case 'error':
      return (
        <Box>
          <Text color="red" bold>err    </Text>
          <Text color="red">{msg.content}</Text>
        </Box>
      );
  }
}
