import React, { useEffect, useMemo, useRef, useState } from 'react';
import { homedir } from 'node:os';
import { Box, Static, useApp, useStdout } from 'ink';
import { Session } from '@agentionai/marshall-engine';
import type { AgentProfile, Provider, Tier } from '@agentionai/marshall-engine';
import type { ApprovalDecision } from '@agentionai/marshall-tools';
import { Setup } from './view/Setup.js';
import { Banner } from './view/Banner.js';
import type { HeaderMeta } from './view/Banner.js';
import { Spinner } from './view/Spinner.js';
import { C, G } from './view/theme.js';
import { shortenPath } from './format.js';
import { MessageRow } from './view/MessageRow.js';
import { ApprovalPanel, APPROVAL_LABELS } from './view/ApprovalPanel.js';
import { PromptFrame } from './view/PromptFrame.js';
import { InputPrompt } from './view/InputPrompt.js';
import { LiveOutput } from './view/LiveOutput.js';
import type { Message } from './view/message.js';
import { useTranscript } from './hooks/useTranscript.js';
import { useApprovals } from './hooks/useApprovals.js';
import { useEngineClient } from './hooks/useEngineClient.js';
import type { TranscriptPort } from './hooks/useEngineClient.js';
import { usePreferences } from './hooks/usePreferences.js';
import { usePasteBuffer } from './hooks/usePasteBuffer.js';
import { useAttachments, describeImage } from './hooks/useAttachments.js';
import { readClipboardImage } from './services/clipboard.js';
import { useSession } from './hooks/useSession.js';
import { useKeyBindings } from './hooks/useKeyBindings.js';
import { startLogin, completeLogin } from './login.js';
import type { LoginSession } from './login.js';
import { runSlashCommand } from './commands.js';
import { SLASH_COMMANDS } from './slashCommands.js';
import { completeAtPath, expandFileMentions } from './fileCompletion.js';
import type { Mode } from './mode.js';
import { traceRender } from './renderTrace.js';

/** Stable empty list — a fresh `[]` each render would churn `<Static>`. */
const NO_MESSAGES: Message[] = [];

export interface AppProps {
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
  /**
   * Per-provider last-used host, loaded from the config `providers` array.
   * Lets the setup wizard re-seed each provider's own host when the user
   * switches providers, instead of reusing a single flat host.
   */
  savedHosts?: Record<string, string | undefined>;
  /**
   * Hands the parent a way to force a full transcript replay. Used on resize:
   * the terminal reflows what is already on screen, so Ink's line-count erase
   * can never be correct — the screen has to be wiped and rebuilt instead.
   */
  registerRedraw?: (redraw: () => void) => void;
}

/** Seams for tests: everything the App would otherwise reach for directly. */
interface AppInjectables {
  /** The boot animation needs a real terminal; without one we jump straight to
   *  the static header (also keeps tests deterministic). */
  animate?: boolean;
  SessionCtor?: typeof Session;
  SetupCtor?: React.ComponentType<any>;
  startLoginCtor?: () => LoginSession;
  completeLoginCtor?: (code: string, session: LoginSession) => Promise<void>;
  readClipboardImageCtor?: typeof readClipboardImage;
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
  savedHosts,
  registerRedraw,
  animate = Boolean(process.stdout.isTTY),
  SessionCtor = Session,
  SetupCtor = Setup,
  startLoginCtor = startLogin,
  completeLoginCtor = completeLogin,
  readClipboardImageCtor = readClipboardImage,
}: AppProps & AppInjectables) {
  traceRender('App');
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [input, setInput] = useState('');
  const [mode, setMode] = useState<Mode>(
    agentProfile.model ? { type: 'idle' } : { type: 'setup', tier: 'deep', chain: true },
  );
  const [steering, setSteering] = useState(false);
  const [booting, setBooting] = useState(Boolean(agentProfile.model) && animate);

  const prefs = usePreferences();
  const transcript = useTranscript();
  const approvals = useApprovals();
  const pasteBuffer = usePasteBuffer();
  const attachments = useAttachments();

  // ── the header row ─────────────────────────────────────────────────────────
  const headerMeta = (deep: AgentProfile, fast?: AgentProfile): HeaderMeta => ({
    provider: deep.provider,
    model: deep.model ?? 'default',
    dir: shortenPath(workspaceRoot, homedir()),
    fastModel: fast?.model,
    fastProvider: fast?.provider,
  });
  const headerMessage = (deep: AgentProfile, fast?: AgentProfile): Message =>
    ({ key: transcript.nextKey(), role: 'header', content: '', meta: headerMeta(deep, fast) });

  // ── engine client ──────────────────────────────────────────────────────────
  //
  // The client is memoised once and fires at event time, so everything it reads
  // has to come through a ref rather than a closed-over render value.
  const live = useRef({ transcript, approvals, setSteering, prefs });
  live.current = { transcript, approvals, setSteering, prefs };

  // Preference gating lives here, not in the translator, so the translator stays
  // a pure event → transcript mapping.
  const client = useEngineClient(useMemo((): TranscriptPort => ({
    push: (role, content, extra) => live.current.transcript.push(role, content, extra),
    appendToken: (text) => {
      if (live.current.prefs.read().stream) live.current.transcript.appendStream(text);
    },
    appendReasoning: (text) => {
      if (live.current.prefs.read().showReasoning) live.current.transcript.appendReasoning(text);
    },
    takeStream: () => live.current.transcript.takeStream(),
    takeReasoning: () => live.current.transcript.takeReasoning(),
    turnEnded: (outcome) => {
      live.current.setSteering(outcome === 'interrupted');
      setMode({ type: 'idle' });
    },
    requestApproval: (request) => {
      const { promise, show } = live.current.approvals.enqueue(request);
      if (show) setMode({ type: 'approval', request: show });
      return promise;
    },
    showUsage: () => live.current.prefs.read().showUsage,
  }), []));

  const { session, activeProfile, fastProfile, savedHosts: hosts, applyProfiles, stageProfile } =
    useSession({
      workspaceRoot, agentProfile, fastProfile: initialFastProfile,
      contextAgentProfile, plannerAgentProfile, reviewerAgentProfile,
      enableGitHub, enableWebSearch, maxTokens, savedHosts,
      client, SessionCtor,
      onProfilesChanged: (deep, fast) => transcript.reset([headerMessage(deep, fast)]),
    });

  useEffect(() => {
    registerRedraw?.(() => transcript.replay());
  }, [registerRedraw]);

  // ── quitting ───────────────────────────────────────────────────────────────
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

  // ── keys ───────────────────────────────────────────────────────────────────
  // Tab completes two things: a slash command being typed, and the `@path`
  // under the cursor one directory segment at a time.
  const ghost = useMemo(() => {
    if (mode.type !== 'idle') return '';
    if (input.startsWith('/') && input.length >= 2) {
      const match = SLASH_COMMANDS.find(cmd => cmd.startsWith(input) && cmd !== input);
      return match ? match.slice(input.length) : '';
    }
    return completeAtPath(input, process.cwd());
  }, [input, mode.type]);

  useKeyBindings({
    mode,
    hasCompletion: ghost !== '',
    acceptCompletion: () => setInput(input + ghost),
    toggleReasoning: () => {
      const on = prefs.toggle('showReasoning');
      if (!on) transcript.takeReasoning();
      transcript.push('info', on ? 'reasoning shown (ctrl-r to hide)' : 'reasoning hidden');
    },
    attachImage: () => {
      const result = readClipboardImageCtor();
      if ('error' in result) {
        transcript.push('info', result.error);
        return;
      }
      // The label goes into the prompt so the user can write around it, and so
      // a second image is something they can refer to by name.
      // Trailing space because the cursor lands after the label: without it the
      // next thing typed runs into it, and `[image #1]what do you think?` is
      // what the model would be asked to read.
      const label = attachments.add(result.image);
      const before = input.trimEnd();
      setInput(before === '' ? `${label} ` : `${before} ${label} `);
      transcript.push('info', `attached ${label} — ${describeImage(result.image)}`);
    },
    quit,
    interrupt: () => session?.interrupt(),
    interruptApproval: () => {
      const denied = approvals.denyAll();
      if (denied > 0) {
        transcript.push('info', denied > 1
          ? `${G.no} denied ${denied} actions (interrupted)`
          : `${G.no} denied (interrupted)`);
      }
      session?.interrupt();
      setMode({ type: 'running' });
    },
  });

  // ── approvals ──────────────────────────────────────────────────────────────
  const resolveApproval = (decision: ApprovalDecision) => {
    const next = approvals.resolve(decision);
    if (!next) return;
    transcript.push('info', APPROVAL_LABELS[decision]);
    setMode(next.show ? { type: 'approval', request: next.show } : { type: 'running' });
  };

  // ── setup wizard ───────────────────────────────────────────────────────────
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

    if (tier === 'fast') {
      applyProfiles(activeProfile, chosen);
    } else if (chain) {
      // First run: pick the delegation target next, before starting a session.
      stageProfile(chosen ?? activeProfile);
      setMode({ type: 'setup', tier: 'fast', chain: false });
      return;
    } else {
      applyProfiles(chosen ?? activeProfile, fastProfile);
    }
    setMode({ type: 'idle' });
  };

  // ── submitting ─────────────────────────────────────────────────────────────
  const handleSubmit = (value: string) => {
    // Expand before anything reads the text — the placeholder is a display
    // device, and every branch below (login code, slash command, task) wants
    // what the user actually pasted.
    const text = pasteBuffer.expand(value).trim();
    // Read off the submitted text, so an image whose label the user deleted is
    // dropped rather than sent invisibly.
    const images = attachments.attachedTo(text);
    setInput('');
    pasteBuffer.clear();
    attachments.clear();
    if (!text) return;

    if (mode.type === 'login-pending') {
      const login = mode.session;
      setMode({ type: 'idle' });
      completeLoginCtor(text, login)
        .then(() => transcript.push('info', `${G.ok} logged in — your session is now authenticated`))
        .catch((err: unknown) => transcript.push('error', err instanceof Error ? err.message : String(err)));
      return;
    }

    if (text.startsWith('/')) {
      runSlashCommand(text, {
        workspaceRoot, transcript, session, approvals, prefs, setMode, setSteering,
        headerMessage: () => headerMessage(activeProfile, fastProfile),
        applyProfiles, activeProfile, quit,
        startLogin: startLoginCtor,
      });
      return;
    }

    transcript.push('user', text);
    setSteering(false);
    setMode({ type: 'running' });
    // Inline every `@path` that resolves, so the model sees the contents rather
    // than a path it would have to spend a read_file call on. Files that
    // cannot be inlined stay as typed — the agent can still reach them.
    const expanded = expandFileMentions(text, workspaceRoot);
    if (expanded.mentions.length > 0) {
      const notes = expanded.mentions.map(m =>
        m.outcome === 'ok'
          ? `${m.token} inlined (${m.bytes} B)`
          : m.outcome === 'too-large'
            ? `${m.token} too large to inline — the agent can read_file it`
            : `${m.token} is binary — left as a path`);
      transcript.push('info', notes.join(' · '));
    }
    session?.run(expanded.text, images).catch((err) => {
      transcript.push('error', err instanceof Error ? err.message : String(err));
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
          savedHosts={hosts}
          onComplete={(p: Provider | null, m: string | null, h?: string, k?: string) =>
            handleSetupComplete(tier, chain, p, m, h, k)}
          onExit={() => setMode({ type: 'idle' })}
        />
      </Box>
    );
  }

  const accepting = mode.type === 'idle' || mode.type === 'login-pending';

  return (
    <Box flexDirection="column">
      {/* Held back until boot finishes so the static header can never be on
          screen at the same time as the animated one. */}
      <Static key={transcript.epoch} items={booting ? NO_MESSAGES : transcript.messages}>
        {(msg) => <MessageRow key={msg.key} msg={msg} />}
      </Static>

      {booting && (
        <Banner
          meta={headerMeta(agentProfile, initialFastProfile)}
          onDone={() => {
            transcript.reset([headerMessage(agentProfile, initialFastProfile)]);
            setBooting(false);
          }}
        />
      )}

      {/* `stdout` updates on SIGWINCH and we re-render per token, so a resize is
          picked up on the next one. */}
      <LiveOutput
        stream={transcript.stream}
        reasoning={transcript.reasoning}
        columns={stdout?.columns ?? 80}
        rows={stdout?.rows ?? 24}
      />

      {mode.type === 'approval' && (
        <ApprovalPanel
          request={mode.request}
          pending={approvals.pending}
          onSelect={resolveApproval}
        />
      )}

      {!booting && mode.type === 'running' && (
        <PromptFrame color={C.accent} hint={`esc interrupts ${G.bullet} esc esc quits`}>
          <Spinner />
        </PromptFrame>
      )}

      {!booting && accepting && (
        <InputPrompt
          kind={mode.type === 'login-pending' ? 'login' : steering ? 'steering' : 'task'}
          value={input}
          ghost={ghost}
          onPaste={pasteBuffer.capture}
          onChange={setInput}
          onSubmit={handleSubmit}
        />
      )}
    </Box>
  );
}
