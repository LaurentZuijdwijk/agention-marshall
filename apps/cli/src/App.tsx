import React, { useEffect, useMemo, useRef, useState } from 'react';
import { homedir } from 'node:os';
import { Box, Static, useApp, useStdout } from 'ink';
import { Session, formatCost } from '@agentionai/marshall-engine';
import type { AgentProfile, Provider, Tier, McpServerConfig, SafetyLevel } from '@agentionai/marshall-engine';
import type { ApprovalDecision } from '@agentionai/marshall-tools';
import { Setup } from './view/Setup.js';
import { McpSetup } from './view/McpSetup.js';
import type { McpScope } from './view/McpSetup.js';
import { Banner } from './view/Banner.js';
import type { HeaderMeta } from './view/Banner.js';
import { C, G } from './view/theme.js';
import { shortenPath } from './format.js';
import { MessageRow } from './view/MessageRow.js';
import { ApprovalPanel, APPROVAL_LABELS } from './view/ApprovalPanel.js';
import { QuestionPanel } from './view/QuestionPanel.js';
import { PromptFrame } from './view/PromptFrame.js';
import { InputPrompt } from './view/InputPrompt.js';
import { LiveOutput } from './view/LiveOutput.js';
import { ActivityStatus } from './view/ActivityStatus.js';
import type { ActivityMetrics } from './view/ActivityStatus.js';
import { panelLayout, safeWidth } from './view/layout.js';
import type { Message } from './view/message.js';
import { useTranscript } from './hooks/useTranscript.js';
import { useApprovals } from './hooks/useApprovals.js';
import { useQuestions, NO_ANSWER } from './hooks/useQuestions.js';
import { useEngineClient } from './hooks/useEngineClient.js';
import type { TranscriptPort } from './hooks/useEngineClient.js';
import { usePreferences } from './hooks/usePreferences.js';
import { usePasteBuffer } from './hooks/usePasteBuffer.js';
import { useAttachments, describeImage } from './hooks/useAttachments.js';
import { readClipboardImage } from './services/clipboard.js';
import { fetchOpenRouterPricing } from './services/pricing.js';
import { useSession } from './hooks/useSession.js';
import { useKeyBindings } from './hooks/useKeyBindings.js';
import { startLogin, completeLogin } from './login.js';
import type { LoginSession } from './login.js';
import { runSlashCommand } from './commands.js';
import { describeUpdate } from './update-check.js';
import type { UpdateInfo } from './update-check.js';
import { saveMcpServers, saveProjectMcpSelection } from './services/config-store.js';
import { completeSlash, SAFETY_LEVEL_LABELS } from './slashCommands.js';
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
  /** Start with the lean tool belt — see EngineConfig.light. `/light` toggles it. */
  light?: boolean;
  /**
   * Per-provider last-used host, loaded from the config `providers` array.
   * Lets the setup wizard re-seed each provider's own host when the user
   * switches providers, instead of reusing a single flat host.
   */
  savedHosts?: Record<string, string | undefined>;
  /** Per-provider stored API keys, so the wizard's key step can be confirmed
   *  with a bare enter instead of retyping a secret already on disk. */
  savedKeys?: Record<string, string | undefined>;
  /** MCP servers from the global config, connected when the session starts. */
  mcpServers?: McpServerConfig[];
  /** MCP config that resolves to nothing — surfaced at startup and by `/mcp`. */
  mcpWarnings?: string[];
  /**
   * The startup version check, started before render so the network round trip
   * overlaps with boot. A newer release becomes one row in the transcript.
   *
   * Passed in rather than called here so it is a seam: a test hands over a
   * resolved promise, and nothing reaches the npm registry.
   */
  updateCheck?: Promise<UpdateInfo | null>;
  /** Force a full transcript replay after terminal resize. */
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
  light = false,
  savedHosts,
  savedKeys,
  mcpServers,
  mcpWarnings,
  updateCheck,
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
  const [pendingPrompts, setPendingPrompts] = useState<string[]>([]);
  const [activity, setActivity] = useState<'idle' | 'loading' | 'thinking' | 'generating' | 'complete' | 'error' | 'cancelled'>('idle');
  const [metrics, setMetrics] = useState<ActivityMetrics>({});
  const [mode, setMode] = useState<Mode>(
    agentProfile.model ? { type: 'idle' } : { type: 'setup', tier: 'deep', chain: true },
  );
  const [steering, setSteering] = useState(false);
  // Session-only by design (see /safety) — always starts at the default gate,
  // and is mirrored here purely so the header can show it once it changes;
  // the engine's own `session.safetyLevel` is the actual source of truth.
  const [safetyLevel, setSafetyLevelState] = useState<SafetyLevel>(2);
  const [booting, setBooting] = useState(Boolean(agentProfile.model) && animate);

  const prefs = usePreferences();
  const transcript = useTranscript();
  const approvals = useApprovals();
  const questions = useQuestions();
  const pasteBuffer = usePasteBuffer();
  const attachments = useAttachments();

  // ── the header row ─────────────────────────────────────────────────────────
  const headerMeta = (deep: AgentProfile, fast?: AgentProfile): HeaderMeta => ({
    provider: deep.provider,
    model: deep.model ?? 'default',
    dir: shortenPath(workspaceRoot, homedir()),
    fastModel: fast?.model,
    fastProvider: fast?.provider,
    safety: SAFETY_LEVEL_LABELS[safetyLevel],
  });
  const headerMessage = (deep: AgentProfile, fast?: AgentProfile, compact = false): Message =>
    ({ key: transcript.nextKey(), role: 'header', content: '', meta: headerMeta(deep, fast), compact });

  // ── engine client ──────────────────────────────────────────────────────────
  //
  // The client is memoised once and fires at event time, so everything it reads
  // has to come through a ref rather than a closed-over render value.
  const live = useRef({ transcript, approvals, questions, setSteering, prefs });
  live.current = { transcript, approvals, questions, setSteering, prefs };

  // Preference gating lives here, not in the translator, so the translator stays
  // a pure event → transcript mapping.
  const client = useEngineClient(useMemo((): TranscriptPort => ({
    push: (role, content, extra) => live.current.transcript.push(role, content, extra),
    appendToken: (text) => {
      setActivity('generating');
      if (live.current.prefs.read().stream) live.current.transcript.appendStream(text);
    },
    appendReasoning: (text) => {
      if (live.current.prefs.read().showReasoning) live.current.transcript.appendReasoning(text);
    },
    takeStream: () => live.current.transcript.takeStream(),
    takeReasoning: () => live.current.transcript.takeReasoning(),
    // Only `idle` is promoted. A turn started by a finished background job must
    // put the spinner up in place of the input prompt, but it must not shove the
    // setup wizard, a login prompt or a pending approval off the screen to do it
    // — those are waiting on the user, and the turn can render underneath them.
    turnStarted: () => {
      setActivity('thinking');
      setMetrics({});
      setMode(prev => (prev.type === 'idle' ? { type: 'running' } : prev));
    },
    // The turn's rollup, not the session's: the row sits under the turn you are
    // watching. `/tokens` is where the session total lives.
    reportUsage: ({ turn, durationMs, rates, ttftMs }) => {
      setMetrics({
        inputTokens: turn.inputTokens,
        outputTokens: turn.outputTokens,
        durationMs,
        cost: formatCost(turn),
        rates,
        ttftMs,
        reasoningTokens: turn.reasoningTokens,
      });
    },
    turnEnded: (outcome) => {
      live.current.setSteering(outcome === 'interrupted');
      setActivity(outcome === 'done' ? 'complete' : outcome === 'interrupted' ? 'cancelled' : 'error');
      setMode({ type: 'idle' });
    },
    requestApproval: (request) => {
      const { promise, show } = live.current.approvals.enqueue(request);
      if (show) setMode({ type: 'approval', request: show });
      return promise;
    },
    askUser: (request) => {
      const { promise, show } = live.current.questions.enqueue(request);
      if (show) setMode({ type: 'question', request: show });
      return promise;
    },
  }), []));

  const { session, activeProfile, fastProfile, savedHosts: hosts, savedKeys: keys, applyProfiles, stageProfile } =
    useSession({
      workspaceRoot, agentProfile, fastProfile: initialFastProfile,
      contextAgentProfile, plannerAgentProfile, reviewerAgentProfile,
      enableGitHub, enableWebSearch, maxTokens, light, savedHosts, savedKeys, mcpServers,
      client, SessionCtor,
      // Appended, not reset: the session keeps its history across a model
      // switch now, so wiping the visible conversation would misrepresent what
      // the new model can actually see. Compact because `<Static>` has already
      // written the boot banner to the terminal for good — a second full header
      // prints another logo rather than replacing the first.
      onProfilesChanged: (deep, fast) =>
        transcript.push('header', '', { meta: headerMeta(deep, fast), compact: true }),
    });

  useEffect(() => {
    registerRedraw?.(() => transcript.replay());
  }, [registerRedraw, transcript]);

  // Prices, once, in the background — a turn that finishes before the catalogue
  // lands reports tokens without a cost and picks the cost up on the next one,
  // which is a better trade than holding up boot for a network round trip.
  // Skipped entirely when nothing routes through OpenRouter, so the common
  // single-provider session makes no request at all.
  useEffect(() => {
    if (!session) return;
    if (![activeProfile, fastProfile].some(profile => profile?.provider === 'openrouter')) return;
    const abort = new AbortController();
    void fetchOpenRouterPricing(abort.signal).then((prices) => {
      if (!abort.signal.aborted && prices.size > 0) session.setPricing(prices);
    });
    return () => abort.abort();
  }, [session, activeProfile?.provider, fastProfile?.provider]);

  // Announced once at startup rather than only on /mcp: a project that enables a
  // server nothing defines otherwise looks exactly like a project with no MCP,
  // and the user has no reason to go looking.
  useEffect(() => {
    // A dangling project selection is actionable configuration guidance, not a
    // failed connection; keep it in the informational MCP status style.
    for (const warning of mcpWarnings ?? []) transcript.push('info', warning);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Held until boot finishes, because the animation's `onDone` *replaces* the
  // transcript with a fresh header — a row pushed before that is thrown away.
  // The check is a network round trip racing an animation, so which one wins is
  // luck, and the losing case is a notice that silently never appears.
  useEffect(() => {
    if (booting || !updateCheck) return;
    let cancelled = false;
    void updateCheck.then((info) => {
      if (cancelled || !info) return;
      transcript.push('info', `${describeUpdate(info)} — type /update to install`);
    });
    return () => { cancelled = true; };
  }, [booting, updateCheck]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── quitting ───────────────────────────────────────────────────────────────
  const quit = () => {
    // Abort in-flight work first: this cancels the LLM request and kills any
    // running shell process, which is what actually frees the event loop.
    session?.interrupt();
    // Background jobs are detached and survive an interrupt by design, so they
    // need killing explicitly — otherwise quitting leaves a dev server running
    // with nothing attached to it.
    session?.dispose();
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
    if (input.startsWith('/')) return completeSlash(input);
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

  // ── mcp ────────────────────────────────────────────────────────────────────
  //
  // Fire and forget, like the model config: a failed write costs the user
  // re-adding the server next session, not this one.
  const persistMcp = (enableForProjectOnly?: string) => {
    if (!session) return;
    const servers = session.mcpServers().map(server =>
      server.name === enableForProjectOnly ? { ...server, enabled: false } : server);
    void saveMcpServers(servers).catch(() => {});
    if (enableForProjectOnly) {
      void saveProjectMcpSelection(workspaceRoot, current => ({
        ...current,
        enable: [...new Set([...(current.enable ?? []), enableForProjectOnly])],
      })).catch(() => {});
    }
  };

  const handleMcpAdd = (server: McpServerConfig, scope: McpScope) => {
    setMode({ type: 'idle' });
    if (!session) return;
    transcript.push('info', `connecting to ${server.name}…`);
    session.addMcpServer(server)
      .then((state) => {
        if (state.status === 'connected') {
          transcript.push('info',
            `${G.ok} ${state.name} connected — ${state.toolNames.length} tools, ` +
            'each one asks before it runs');
          // Persisted only on success. Writing a server we could not reach
          // would retry it on every future start and fail there too.
          //
          // The definition always goes to the global config — it can hold a
          // bearer token, and that never belongs in a repo. `project` scope
          // marks it off-by-default there and opts this one checkout in, so the
          // committed file names a server without carrying its credentials.
          persistMcp(scope === 'project' ? state.name : undefined);
        } else {
          transcript.push('error', `${state.name}: ${state.error ?? 'could not connect'}`);
        }
      })
      .catch((err: unknown) => transcript.push('error', err instanceof Error ? err.message : String(err)));
  };

  // ── safety judge wizard (/safety agentic) ─────────────────────────────────
  //
  // Deliberately does not go through `applyProfiles`/`persist()` — the safety
  // level and its judge model are session-only (see Session.setSafetyAgent),
  // so nothing here touches config-store.
  const handleSafetySetupComplete = (
    provider: Provider | null,
    model: string | null,
    host?: string,
    apiKey?: string,
  ) => {
    if (provider && model && session) {
      session.setSafetyAgent({ profile: { provider, model, host, ...(apiKey ? { apiKey } : {}) } });
      session.setSafetyLevel(3);
      setSafetyLevelState(3);
      transcript.push('info', `safety: agentic — reviewing tool calls with ${provider}/${model}`);
    }
    setMode({ type: 'idle' });
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
    // While a turn is active, capture the prompt explicitly instead of dropping it
    // or starting a concurrent engine run with ambiguous ordering.
    if (mode.type === 'running' || mode.type === 'approval') {
      const queued = pasteBuffer.expand(value).trim();
      if (!queued) return;
      setPendingPrompts(previous => [...previous, queued]);
      setInput('');
      pasteBuffer.clear();
      transcript.push('info', `queued prompt ${pendingPrompts.length + 1} — it will run after the active request`);
      return;
    }
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
        onMcpChanged: persistMcp,
        mcpWarnings,
        applyProfiles, activeProfile, quit,
        startLogin: startLoginCtor,
        onSafetyLevelChange: setSafetyLevelState,
      });
      return;
    }

    transcript.push('user', text);
    setSteering(false);
    setActivity('thinking');
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

  // Start queued prompts one at a time after the active request reaches a terminal state.
  // This is explicit FIFO handling: no prompt is silently discarded or run concurrently.
  useEffect(() => {
    if (activity !== 'complete' && activity !== 'error' && activity !== 'cancelled') return;
    const [next, ...rest] = pendingPrompts;
    if (!next) return;
    setPendingPrompts(rest);
    setActivity('idle');
    handleSubmit(next);
  // handleSubmit is intentionally event-local; this effect reacts only to lifecycle completion.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity, pendingPrompts]);

  /** What to pre-fill the wizard with for the tier being chosen. */
  const seedProfile = (tier: Tier) => {
    const seed = tier === 'fast' ? (fastProfile ?? activeProfile) : activeProfile;
    return { provider: seed.provider, model: seed.model, host: seed.host };
  };

  // ── render ─────────────────────────────────────────────────────────────────
  //
  // The wizards render *inside* the tree below rather than replacing it. Ink's
  // <Static> keeps the count of rows it has already emitted in component state,
  // so unmounting it — which an early return here used to do — resets that
  // count to zero and makes it re-emit the whole transcript on the way back.
  // That was the duplicate banner after a model switch.
  const wizard =
    mode.type === 'mcp-setup' ? (
      <Box padding={1}>
        <McpSetup
          existing={session?.mcpState().map(s => s.name) ?? []}
          onComplete={handleMcpAdd}
          onExit={() => setMode({ type: 'idle' })}
        />
      </Box>
    ) : mode.type === 'setup' ? (
      <Box padding={1}>
        <SetupCtor
          key={mode.tier}
          tier={mode.tier}
          deepLabel={activeProfile.model}
          // The fast tier usually lives on the same server as deep, so seed it
          // from whichever profile is closest to what the user is about to pick.
          initial={seedProfile(mode.tier)}
          savedHosts={hosts}
          savedKeys={keys}
          onComplete={(p: Provider | null, m: string | null, h?: string, k?: string) =>
            handleSetupComplete(mode.tier, mode.chain, p, m, h, k)}
          onExit={() => setMode({ type: 'idle' })}
        />
      </Box>
    ) : mode.type === 'safety-setup' ? (
      <Box padding={1}>
        <SetupCtor
          title="safety judge model"
          blurb='reviews each tool call before it runs — a "safe" verdict skips your approval, "unsafe" still asks you, with its reasoning attached'
          savedHosts={hosts}
          savedKeys={keys}
          onComplete={handleSafetySetupComplete}
          onExit={() => setMode({ type: 'idle' })}
        />
      </Box>
    ) : null;

  const accepting = mode.type === 'idle' || mode.type === 'running' || mode.type === 'login-pending' || mode.type === 'approval';

  // Everything below <Static> shares one height budget, and blowing it makes Ink
  // repaint the whole screen — transcript included — on every render. That is
  // the flicker, the dead scrollback and the doubled rows all at once, so the
  // panels are given their rows explicitly rather than sized to their content.
  // See view/layout.ts.
  const columns = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 24;
  const modal = mode.type === 'approval' || mode.type === 'question';
  const panel = panelLayout(rows);

  return (
    // The width is load-bearing, not cosmetic. Nothing may reach the terminal's
    // last column: Ink erases the frame by rewinding as many rows as the output
    // has lines, so a line the terminal had to wrap costs a row the rewind never
    // gets back, and the top of the frame is left on screen — one stale row per
    // frame, which is the duplicated output. See view/layout.ts.
    <Box flexDirection="column" width={safeWidth(columns)}>
      {/* The same width again, per row, because <Static> does not inherit it:
          Ink lays static items out in their own pass, against the full terminal.
          Without this the committed transcript rendered past the last column and
          was hard-wrapped mid-word while the live region below it stayed inside.

          Items are held back until boot finishes, so the static header can never
          be on screen at the same time as the animated one. */}
      <Static key={transcript.epoch} items={booting ? NO_MESSAGES : transcript.messages}>
        {(msg) => (
          <Box key={msg.key} flexDirection="column" width={safeWidth(columns)}>
            <MessageRow msg={msg} columns={safeWidth(columns)} />
          </Box>
        )}
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
        columns={columns}
        rows={rows}
      />

      {mode.type === 'approval' && (
        <ApprovalPanel
          request={mode.request}
          pending={approvals.pending}
          columns={columns}
          rows={panel.rows}
          onSelect={resolveApproval}
        />
      )}
      {mode.type === 'question' && (
        <QuestionPanel
          request={mode.request}
          pending={questions.pending}
          columns={columns}
          rows={panel.rows}
          onAnswer={(answer) => { const next = questions.resolve(answer); transcript.push('user', answer); setMode(next?.show ? { type: 'question', request: next.show } : { type: 'running' }); }}
          onCancel={() => { const next = questions.resolve(NO_ANSWER); setMode(next?.show ? { type: 'question', request: next.show } : { type: 'running' }); }}
        />
      )}

      {!booting && (
        <ActivityStatus state={activity} metrics={metrics} pending={pendingPrompts.length} blocked={modal} />
      )}

      {wizard}

      {/* Typing under an approval queues a prompt rather than answering it, so
          on a terminal too short to hold both the panel wins and the input goes.
          Esc still interrupts, and the approval keys still work. */}
      {!booting && accepting && !wizard && (!modal || panel.showPrompt) && (
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
