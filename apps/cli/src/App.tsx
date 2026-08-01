import React, { useRef, useState, useMemo } from 'react';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Box, Text, Static, useApp, useInput } from 'ink';
import { TextInput } from './TextInput.js';
import { Session } from '@marshall/engine';
import type { AgentProfile, OutputEvent, ClientInterface, Provider, Tier } from '@marshall/engine';
import type { ApprovalRequest, ApprovalDecision } from '@marshall/tools';
import { Setup } from './Setup.js';
import { startLogin, completeLogin } from './login.js';
import type { LoginSession } from './login.js';
import { Banner, Header } from './Banner.js';
import type { HeaderMeta } from './Banner.js';
import { Spinner } from './Spinner.js';
import { Markdown } from './Markdown.js';
import { C, G } from './theme.js';
import { formatToolInput, shortenPath } from './format.js';
import { traceRender } from './renderTrace.js';

// ── types ─────────────────────────────────────────────────────────────────────

type MessageRole =
  | 'header' | 'user' | 'assistant' | 'markdown' | 'tool' | 'tool-result'
  | 'info' | 'usage' | 'error' | 'reasoning';

interface Message {
  key: string;
  role: MessageRole;
  content: string;
  /** Header rows carry the session summary instead of text. */
  meta?: HeaderMeta;
  /** Tool name, or the heading above a markdown block. */
  title?: string;
  /** Dim aside next to the title. */
  note?: string;
}

type Mode =
  // `chain` continues on to the fast tier once deep is chosen — that's the
  // first-run flow. `/model fast` sets just one tier and stops.
  | { type: 'setup'; tier: Tier; chain: boolean }
  | { type: 'idle' }
  | { type: 'running' }
  | { type: 'login-pending'; session: LoginSession }
  | { type: 'approval'; request: ApprovalRequest };

// ── help text ──────────────────────────────────────────────────────────────────

import { HELP, SLASH_COMMANDS } from './slashCommands.js';

// ── approval select ────────────────────────────────────────────────────────────

const APPROVAL_OPTIONS: Array<{ label: string; hint: string; value: ApprovalDecision; color: string }> = [
  { label: 'Approve',                  hint: 'y', value: 'approve', color: C.ok    },
  { label: 'Always approve this tool', hint: 'a', value: 'always',  color: C.ok    },
  { label: 'Deny',                     hint: 'n', value: 'deny',    color: C.error },
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
      {APPROVAL_OPTIONS.map((opt, i) => {
        const active = i === cursor;
        return (
          <Box key={opt.value}>
            <Text color={active ? opt.color : C.faint} bold={active}>
              {active ? `${G.prompt} ` : '  '}
            </Text>
            <Text color={active ? opt.color : C.muted} bold={active}>
              {opt.label.padEnd(26)}
            </Text>
            <Text color={C.faint}>{opt.hint}</Text>
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text color={C.faint}>
          ↑↓ move {G.bullet} enter select {G.bullet} esc deny all and interrupt
        </Text>
      </Box>
    </Box>
  );
}

// ── approval panel ─────────────────────────────────────────────────────────────

/** Colour unified-diff and shell output so the proposed change reads at a glance. */
function detailColor(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return C.muted;
  if (line.startsWith('@@'))  return C.accent;
  if (line.startsWith('+'))   return C.ok;
  if (line.startsWith('-'))   return C.error;
  return C.muted;
}

const DETAIL_LINES = 20;

function ApprovalPanel({ request, pending, onSelect }: {
  request: ApprovalRequest;
  pending: number;
  onSelect: (d: ApprovalDecision) => void;
}) {
  const lines = request.detail.split('\n');
  const overflow = lines.length - DETAIL_LINES;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={C.warn} paddingX={1} marginY={1}>
      <Box>
        <Text color={C.warn} bold>{G.warn} approval required</Text>
        {pending > 1 && <Text color={C.faint}>  {pending} queued</Text>}
      </Box>

      <Box marginTop={1}>
        <Text color={C.tool} bold>{request.toolName}</Text>
        <Text color={C.muted}>  {request.description}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {lines.slice(0, DETAIL_LINES).map((line, i) => (
          <Text key={i} color={detailColor(line)}>{line}</Text>
        ))}
        {overflow > 0 && <Text color={C.faint}>… {overflow} more lines</Text>}
      </Box>

      <ApprovalSelect onSelect={onSelect} />
    </Box>
  );
}

// ── assistant text ─────────────────────────────────────────────────────────────

/**
 * Assistant prose: a brand diamond in the gutter, markdown-rendered body. The
 * body sits in its own column so wrapped lines hang under the first character
 * rather than under the diamond.
 */
function AssistantText({ text }: { text: string }) {
  return (
    <Box marginBottom={1}>
      <Text color={C.accent}>{G.assistant} </Text>
      <Box flexDirection="column" flexGrow={1}>
        <Markdown text={text} />
      </Box>
    </Box>
  );
}

// ── prompt frame ───────────────────────────────────────────────────────────────

/** The bordered box at the bottom — holds either the input or the busy spinner. */
function PromptFrame({ color, hint, children }: {
  color: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box borderStyle="round" borderColor={color} paddingX={1}>
        {children}
      </Box>
      <Box paddingX={2}>
        <Text color={C.faint}>{hint}</Text>
      </Box>
    </Box>
  );
}

// ── main component ─────────────────────────────────────────────────────────────

/** Stable empty list — a fresh `[]` each render would churn `<Static>`. */
const NO_MESSAGES: Message[] = [];

interface AppProps {
  workspaceRoot: string;
  /** The deep tier — the model that writes code, plans and reviews. */
  agentProfile: AgentProfile;
  /** The fast tier. Absent means no tiering: every role runs on `agentProfile`. */
  fastProfile?: AgentProfile;
  contextAgentProfile?: AgentProfile;
  plannerAgentProfile?: AgentProfile;
  reviewerAgentProfile?: AgentProfile;
  enableGitHub?: boolean;
  enableWebSearch?: boolean;
  maxTokens?: number;
}

export function App({
  workspaceRoot,
  agentProfile,
  fastProfile: initialFastProfile,
  contextAgentProfile,
  plannerAgentProfile,
  reviewerAgentProfile,
  enableGitHub = false,
  enableWebSearch = true,
  maxTokens,
  // The boot animation needs a real terminal; without one we jump straight to
  // the static header (also keeps tests deterministic).
  animate = Boolean(process.stdout.isTTY),
  // injectable for testing
  SessionCtor = Session,
  SetupCtor = Setup,
  startLoginCtor = startLogin,
  completeLoginCtor = completeLogin,
}: AppProps & {
  animate?: boolean;
  SessionCtor?: typeof Session;
  SetupCtor?: React.ComponentType<any>;
  startLoginCtor?: () => LoginSession;
  completeLoginCtor?: (code: string, session: LoginSession) => Promise<void>;
}) {
  traceRender('App');
  const { exit } = useApp();
  const counter = useRef(0);
  const makeKey = () => String(++counter.current);

  const headerMeta = (profile: AgentProfile, fast?: AgentProfile): HeaderMeta => ({
    provider: profile.provider,
    model: profile.model ?? 'default',
    dir: shortenPath(workspaceRoot, homedir()),
    fastModel: fast?.model,
    fastProvider: fast?.provider,
  });
  const headerMessage = (profile: AgentProfile, fast?: AgentProfile): Message =>
    ({ key: makeKey(), role: 'header', content: '', meta: headerMeta(profile, fast) });

  const booted = Boolean(agentProfile.model) && animate;
  const [booting, setBooting] = useState(booted);

  const [messages, setMessages] = useState<Message[]>(
    agentProfile.model && !booted ? [headerMessage(agentProfile, initialFastProfile)] : [],
  );
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<Mode>(
    agentProfile.model ? { type: 'idle' } : { type: 'setup', tier: 'deep', chain: true },
  );
  const [activeProfile, setActiveProfile] = useState<AgentProfile>(agentProfile);
  const [fastProfile, setFastProfile] = useState<AgentProfile | undefined>(initialFastProfile);
  const [steering, setSteering] = useState(false);
  const [streamBuffer, setStreamBuffer] = useState('');
  // Display toggles (see /tokens and /stream). Refs because the engine client
  // is memoised once and reads them at event time, not render time.
  const [showUsage, setShowUsage] = useState(false);
  const [stream, setStream] = useState(true);
  const [showReasoning, setShowReasoning] = useState(false);
  const [reasoningBuffer, setReasoningBuffer] = useState('');
  const showUsageRef = useRef(showUsage);
  showUsageRef.current = showUsage;
  const streamRef = useRef(stream);
  streamRef.current = stream;
  const showReasoningRef = useRef(showReasoning);
  showReasoningRef.current = showReasoning;

  // Queue of pending approvals — multiple tools can request approval
  // simultaneously (parallel tool use). We show them one at a time and chain.
  interface PendingApproval {
    request: ApprovalRequest;
    resolve: (d: ApprovalDecision) => void;
  }
  const approvalQueue = useRef<PendingApproval[]>([]);

  const pushRef = useRef<(role: MessageRole, content: string, extra?: Partial<Message>) => void>(() => {});
  const setSteeringRef = useRef(setSteering);
  setSteeringRef.current = setSteering;

  const push = (role: MessageRole, content: string, extra?: Partial<Message>) => {
    setMessages(prev => [...prev, { key: makeKey(), role, content, ...extra }]);
  };
  pushRef.current = push;

  // ── engine client ──────────────────────────────────────────────────────────
  const client = useMemo((): ClientInterface => ({
    onOutput(event: OutputEvent) {
      switch (event.type) {
        case 'thinking':
          break;
        case 'tool-call':
          pushRef.current('tool', formatToolInput(event.input), { title: event.toolName });
          break;
        case 'tool-result':
          pushRef.current('tool-result', event.result);
          break;
        case 'token':
          if (streamRef.current) setStreamBuffer(prev => prev + event.text);
          break;
        case 'reasoning':
          if (showReasoningRef.current) setReasoningBuffer(prev => prev + event.text);
          break;
        case 'response':
          setStreamBuffer('');
          setReasoningBuffer(prev => {
            if (prev) pushRef.current('reasoning', prev);
            return '';
          });
          pushRef.current('assistant', event.text);
          setSteeringRef.current(false);
          setMode({ type: 'idle' });
          break;
        case 'usage':
          if (showUsageRef.current) {
            pushRef.current('usage', `↑${event.inputTokens}  ↓${event.outputTokens}  ${G.bullet}  ${(event.durationMs / 1000).toFixed(1)}s`);
          }
          break;
        case 'error':
          pushRef.current('error', event.message);
          setSteeringRef.current(false);
          setMode({ type: 'idle' });
          break;
        case 'interrupted':
          setStreamBuffer('');
          setReasoningBuffer('');
          pushRef.current('info', 'interrupted — steer with a new instruction, or /clear to reset');
          setSteeringRef.current(true);
          setMode({ type: 'idle' });
          break;
        case 'plan':
          pushRef.current('markdown', event.text, {
            title: 'plan',
            note: 'will be used as context for your next task',
          });
          setMode({ type: 'idle' });
          break;
        case 'review':
          pushRef.current('markdown', event.text, { title: 'review' });
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

  // Session is created immediately when a model is already known, or lazily
  // after the setup wizard completes.
  // Lazily initialised: `useRef(expr)` evaluates `expr` on *every* render and
  // throws all but the first away, so writing `new Session(...)` inline built
  // a whole Session — History, plugins, mkdir, sub-agents — per render. Any
  // render loop then turned into runaway memory use.
  const sessionRef = useRef<Session | null>(null);
  const sessionInitialised = useRef(false);
  if (!sessionInitialised.current) {
    sessionInitialised.current = true;
    sessionRef.current = agentProfile.model
      ? new SessionCtor({
          agent: agentProfile,
          models: { deep: agentProfile, fast: initialFastProfile },
          workspaceRoot, enableGitHub, enableWebSearch, maxTokens,
          contextAgent: contextAgentProfile,
          plannerAgent: plannerAgentProfile,
          reviewerAgent: reviewerAgentProfile,
        }, client)
      : null;
  }

  /** Rebuild the session and header whenever either tier changes. */
  const applyProfiles = (deep: AgentProfile, fast: AgentProfile | undefined) => {
    setActiveProfile(deep);
    setFastProfile(fast);
    sessionRef.current = new SessionCtor({
      agent: deep,
      models: { deep, fast },
      workspaceRoot, enableGitHub, enableWebSearch, maxTokens,
      contextAgent: contextAgentProfile,
      plannerAgent: plannerAgentProfile,
      reviewerAgent: reviewerAgentProfile,
    }, client);
    setMessages([headerMessage(deep, fast)]);
    saveConfig(deep, fast);
  };

  /**
   * Persist to .marshall/config.json (fire and forget). apiKey is included
   * only when the wizard collected one; the file is written 0600 since it can
   * hold a secret. The flat legacy keys mirror the deep tier so an older
   * build still finds a model.
   */
  const saveConfig = (deep: AgentProfile, fast: AgentProfile | undefined) => {
    const strip = (p: AgentProfile) => ({ provider: p.provider, model: p.model, host: p.host, ...(p.apiKey ? { apiKey: p.apiKey } : {}) });
    mkdir(join(workspaceRoot, '.marshall'), { recursive: true })
      .then(() => writeFile(
        join(workspaceRoot, '.marshall', 'config.json'),
        JSON.stringify({
          ...strip(deep),
          models: { deep: strip(deep), ...(fast ? { fast: strip(fast) } : {}) },
        }, null, 2),
        { mode: 0o600 },
      ))
      .catch(() => {});
  };

  const handleSetupComplete = (
    tier: Tier,
    chain: boolean,
    provider: Provider | null,
    model: string | null,
    host?: string,
    apiKey?: string,
  ) => {
    // provider === null is the "same as deep" row on the fast tier.
    const chosen: AgentProfile | undefined = provider && model
      ? { ...(tier === 'deep' ? agentProfile : {}), provider, model, host, ...(apiKey ? { apiKey } : {}) }
      : undefined;

    if (tier === 'deep') {
      const deep = chosen ?? activeProfile;
      if (chain) {
        // First run: pick the delegation target next, before starting a session.
        setActiveProfile(deep);
        setMode({ type: 'setup', tier: 'fast', chain: false });
        return;
      }
      applyProfiles(deep, fastProfile);
    } else {
      applyProfiles(activeProfile, chosen);
    }
    setMode({ type: 'idle' });
  };

  const session = sessionRef.current;

  // ── slash command autocomplete ─────────────────────────────────────────────
  const ghost = useMemo(() => {
    if (mode.type !== 'idle' || !input.startsWith('/') || input.length < 2) return '';
    const match = SLASH_COMMANDS.find(cmd => cmd.startsWith(input) && cmd !== input);
    return match ? match.slice(input.length) : '';
  }, [input, mode.type]);

  useInput((_, key) => {
    if (key.tab && ghost && mode.type === 'idle') {
      // TextInput snaps its cursor to the end of the new value — no remount.
      setInput(input + ghost);
    }
  });

  // Ctrl-R toggles live chain-of-thought (providers that stream it —
  // OpenRouter thinking models; silent no-op elsewhere).
  useInput((input, key) => {
    if (key.ctrl && input === 'r') {
      const next = !showReasoning;
      setShowReasoning(next);
      if (!next) setReasoningBuffer('');
      push('info', next ? 'reasoning shown (ctrl-r to hide)' : 'reasoning hidden');
    }
  });

  // ── interrupt / quit ───────────────────────────────────────────────────────
  //
  // Esc and Ctrl-C share one handler. While work is in flight the first press
  // interrupts; a second press within the double-tap window quits outright, so
  // a wedged task can never trap the user.
  const DOUBLE_TAP_MS = 500;
  const lastQuitKey = useRef(0);

  const quit = () => {
    // Abort in-flight work first: this cancels the LLM request and kills any
    // running shell process, which is what actually frees the event loop.
    session?.interrupt();
    exit();
    // Ink has restored the terminal by now, but an aborted request can still
    // hold node open — a socket that never settles used to leave the process
    // running with no UI, which read as "Ctrl-C does nothing". The timer is
    // unref'd, so a clean shutdown still exits on its own without waiting.
    setTimeout(() => process.exit(0), 100).unref();
  };

  const denyAllPending = () => {
    const queue = approvalQueue.current.splice(0);
    if (queue.length === 0) return;
    pushRef.current('info',
      queue.length > 1
        ? `${G.no} denied ${queue.length} actions (interrupted)`
        : `${G.no} denied (interrupted)`,
    );
    queue.forEach(item => item.resolve('deny'));
  };

  useInput((input, key) => {
    const isEsc = key.escape;
    const isCtrlC = key.ctrl && input === 'c';
    if (!isEsc && !isCtrlC) return;

    // In the wizard Esc means "go back" — let Setup handle it. It must not
    // count toward the quit double-tap either: terminals that split an
    // arrow-key escape sequence deliver a bare ESC first, so navigating the
    // model list with ↑↓ would otherwise read as Esc Esc and kill the session.
    // Ctrl-C has nothing to interrupt here, so it quits straight away.
    if (mode.type === 'setup') {
      if (isCtrlC) quit();
      return;
    }

    const now = Date.now();
    const doubleTapped = now - lastQuitKey.current < DOUBLE_TAP_MS;
    lastQuitKey.current = now;

    if (doubleTapped) { quit(); return; }

    if (mode.type === 'running') {
      session?.interrupt();
      return;
    }

    if (mode.type === 'approval') {
      denyAllPending();
      session?.interrupt();
      setMode({ type: 'running' });
      return;
    }

    // Idle: Esc is a no-op (double-tap quits), but a lone Ctrl-C means the
    // user wants out and there is nothing running to protect.
    if (isCtrlC) quit();
  });

  // ── resolve an approval decision ───────────────────────────────────────────
  const resolveApproval = (decision: ApprovalDecision) => {
    const item = approvalQueue.current.shift();
    if (!item) return;

    const labels: Record<ApprovalDecision, string> = {
      approve: `${G.ok} approved`,
      always:  `${G.ok} approved (always)`,
      deny:    `${G.no} denied`,
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
  const handleSlash = (text: string): boolean => {
    const cmd = text.split(' ')[0];
    const args = text.slice(cmd.length).trim();
    switch (cmd) {
      case '/plan': {
        if (!args) { push('error', 'usage: /plan <task> — describe what you want planned'); return true; }
        push('user', `/plan ${args}`);
        setMode({ type: 'running' });
        session?.plan(args).catch((err) => {
          push('error', err instanceof Error ? err.message : String(err));
          setMode({ type: 'idle' });
        });
        return true;
      }
      case '/review': {
        push('user', args ? `/review ${args}` : '/review');
        setMode({ type: 'running' });
        session?.review(args || undefined).catch((err) => {
          push('error', err instanceof Error ? err.message : String(err));
          setMode({ type: 'idle' });
        });
        return true;
      }
      case '/help':  push('info', HELP); return true;
      case '/exit':  quit(); return true;
      case '/model': {
        const which = args.toLowerCase();
        if (which === 'deep') { setMode({ type: 'setup', tier: 'deep', chain: false }); return true; }
        if (which === 'fast') { setMode({ type: 'setup', tier: 'fast', chain: false }); return true; }
        if (which === 'off')  { applyProfiles(activeProfile, undefined); return true; }
        if (which !== '') {
          push('error', `usage: /model [deep|fast|off] — got "${args}"`);
          return true;
        }
        setMode({ type: 'setup', tier: 'deep', chain: true });
        return true;
      }
      case '/cwd':     push('info', workspaceRoot); return true;
      case '/tokens': {
        const next = !showUsage;
        setShowUsage(next);
        push('info', `token usage ${next ? 'shown' : 'hidden'} after each response`);
        return true;
      }
      case '/stream': {
        const next = !stream;
        setStream(next);
        if (!next) setStreamBuffer('');
        push('info', next ? 'streaming responses as they arrive' : 'responses shown only when complete');
        return true;
      }
      case '/memory': {
        const memPath = join(workspaceRoot, 'AGENTS.md');
        if (!existsSync(memPath)) {
          push('info', 'No AGENTS.md found. Create one in the workspace root to give the agent persistent context.');
        } else {
          readFile(memPath, 'utf8')
            .then(content => push('markdown', content, { title: 'AGENTS.md', note: 'project memory' }))
            .catch(() => push('error', 'Could not read AGENTS.md'));
        }
        return true;
      }
      case '/login': {
        try {
          const session = startLoginCtor();
          push('info', `Opening browser…\n\nIf it doesn't open, visit:\n${session.authUrl}\n\nPaste the code shown on the page below.`);
          setMode({ type: 'login-pending', session });
        } catch (err: unknown) {
          push('error', err instanceof Error ? err.message : String(err));
        }
        return true;
      }
      case '/clear':
        approvalQueue.current.splice(0).forEach(item => item.resolve('deny'));
        session?.clear().then((summary) => {
          process.stdout.write('\x1Bc');
          counter.current = 0;
          setMessages([
            headerMessage(activeProfile, fastProfile),
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

    // Handle login code paste.
    if (mode.type === 'login-pending') {
      const session = mode.session;
      setMode({ type: 'idle' });
      completeLoginCtor(text, session)
        .then(() => push('info', `${G.ok} logged in — your session is now authenticated`))
        .catch((err: unknown) => push('error', err instanceof Error ? err.message : String(err)));
      return;
    }

    if (text.startsWith('/')) {
      if (!handleSlash(text)) push('error', `unknown command: ${text.split(' ')[0]} — type /help`);
      return;
    }

    push('user', text);
    setSteering(false);
    setMode({ type: 'running' });
    session?.run(text).catch((err) => {
      push('error', err instanceof Error ? err.message : String(err));
      setMode({ type: 'idle' });
    });
  };

  // ── render ─────────────────────────────────────────────────────────────────
  if (mode.type === 'setup') {
    const { tier, chain } = mode;
    // The fast tier usually lives on the same server as deep, so seed it from
    // whichever profile is closest to what the user is about to pick.
    const seed = tier === 'fast' ? (fastProfile ?? activeProfile) : activeProfile;
    return (
      <Box padding={1}>
        <SetupCtor
          key={tier}
          tier={tier}
          deepLabel={activeProfile.model}
          initial={{ provider: seed.provider, model: seed.model, host: seed.host }}
          onComplete={(p: Provider | null, m: string | null, h?: string, k?: string) =>
            handleSetupComplete(tier, chain, p, m, h, k)}
          onExit={() => setMode({ type: 'idle' })}
        />
      </Box>
    );
  }

  const isApproval = mode.type === 'approval';
  const approvalReq = isApproval ? (mode as { type: 'approval'; request: ApprovalRequest }).request : null;

  const promptColor = mode.type === 'login-pending' ? C.warn : steering ? C.warn : C.brandFrom;
  const promptGlyph = mode.type === 'login-pending' ? G.pending : steering ? G.steer : G.prompt;
  const promptHint =
    mode.type === 'login-pending' ? 'paste the code from your browser, then enter'
    : steering                    ? `steering ${G.bullet} your next message course-corrects the agent`
    : `tab completes ${G.bullet} enter sends ${G.bullet} esc esc quits`;

  return (
    <Box flexDirection="column">
      {/* Held back until boot finishes so the static header can never be on
          screen at the same time as the animated one. */}
      <Static items={booting ? NO_MESSAGES : messages}>
        {(msg) => <MessageRow key={msg.key} msg={msg} />}
      </Static>

      {booting && (
        <Banner
          meta={headerMeta(agentProfile, initialFastProfile)}
          onDone={() => { setMessages([headerMessage(agentProfile, initialFastProfile)]); setBooting(false); }}
        />
      )}

      {streamBuffer !== '' && <AssistantText text={streamBuffer} />}

      {reasoningBuffer !== '' && (
        <Box marginBottom={1}>
          <Text color={C.faint} italic>{reasoningBuffer}</Text>
        </Box>
      )}

      {isApproval && approvalReq && (
        <ApprovalPanel
          request={approvalReq}
          pending={approvalQueue.current.length}
          onSelect={resolveApproval}
        />
      )}

      {!booting && mode.type === 'running' && (
        <PromptFrame color={C.accent} hint={`esc interrupts ${G.bullet} esc esc quits`}>
          <Spinner />
        </PromptFrame>
      )}

      {!booting && (mode.type === 'idle' || mode.type === 'login-pending') && (
        <PromptFrame color={promptColor} hint={promptHint}>
          <Box>
            <Text color={promptColor} bold>{promptGlyph} </Text>
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={handleSubmit}
              placeholder={
                mode.type === 'login-pending' ? 'paste code here…'
                : steering                    ? 'steer the agent…'
                : 'type a task, or / for commands…'
              }
            />
            {ghost && <Text color={C.faint}>{ghost}</Text>}
          </Box>
        </PromptFrame>
      )}
    </Box>
  );
}

// ── message row ────────────────────────────────────────────────────────────────

const TOOL_RESULT_LINES = 10;

function MessageRow({ msg }: { msg: Message }) {
  switch (msg.role) {
    case 'header':
      return msg.meta ? <Header meta={msg.meta} /> : null;

    case 'user':
      return (
        <Box marginTop={1}>
          <Text color={C.user} bold>{G.prompt} </Text>
          <Text color={C.text} bold>{msg.content}</Text>
        </Box>
      );

    case 'assistant':
      return <AssistantText text={msg.content} />;

    case 'markdown':
      return (
        <Box flexDirection="column" marginY={1}>
          <Box>
            <Text color={C.warn} bold>{msg.title}</Text>
            {msg.note && <Text color={C.faint}>  {msg.note}</Text>}
          </Box>
          <Markdown text={msg.content} />
        </Box>
      );

    case 'tool':
      return (
        <Box marginTop={1}>
          <Text color={C.tool}>{G.tool} </Text>
          <Text color={C.tool}>{msg.title}</Text>
          {msg.content !== '' && <Text color={C.muted}>  {msg.content}</Text>}
        </Box>
      );

    case 'tool-result': {
      const lines = msg.content.split('\n');
      const overflow = lines.length - TOOL_RESULT_LINES;
      return (
        <Box flexDirection="column">
          {lines.slice(0, TOOL_RESULT_LINES).map((line, i) => (
            <Box key={i}>
              <Text color={C.faint}>  {G.gutter} </Text>
              <Text color={C.muted}>{line}</Text>
            </Box>
          ))}
          {overflow > 0 && (
            <Box>
              <Text color={C.faint}>  {G.gutter} </Text>
              <Text color={C.faint}>… {overflow} more lines</Text>
            </Box>
          )}
        </Box>
      );
    }

    case 'info':
      return (
        <Box flexDirection="column" marginTop={1}>
          {msg.content.split('\n').map((line, i) => (
            <Box key={i}>
              <Text color={C.faint}>{i === 0 ? `${G.bullet} ` : '  '}</Text>
              <Text color={C.warn}>{line}</Text>
            </Box>
          ))}
        </Box>
      );

    case 'usage':
      return (
        <Box>
          <Text color={C.faint}>  {msg.content}</Text>
        </Box>
      );

    case 'reasoning':
      return (
        <Box flexDirection="column" marginY={1}>
          <Text color={C.faint} bold>reasoning</Text>
          <Text color={C.faint} italic>{msg.content}</Text>
        </Box>
      );

    case 'error':
      return (
        <Box marginTop={1}>
          <Text color={C.error} bold>{G.err} </Text>
          <Text color={C.error}>{msg.content}</Text>
        </Box>
      );
  }
}
