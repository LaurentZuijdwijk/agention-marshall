import React, { useEffect, useMemo, useState } from 'react';
import { Box, Static, useApp, useStdout } from 'ink';
import { Session } from '@agentionai/marshall-engine';
import type { AgentProfile, SafetyLevel } from '@agentionai/marshall-engine';
import type { ApprovalDecision } from '@agentionai/marshall-tools';
import { Setup } from './view/Setup.js';
import { Wizard } from './view/Wizard.js';
import { Banner } from './view/Banner.js';
import { G } from './view/theme.js';
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
import { useTranscriptPort } from './hooks/useTranscriptPort.js';
import type { Activity } from './hooks/useTranscriptPort.js';
import { usePreferences } from './hooks/usePreferences.js';
import { usePasteBuffer } from './hooks/usePasteBuffer.js';
import { useAttachments, describeImage } from './hooks/useAttachments.js';
import { readClipboardImage } from './services/clipboard.js';
import { fetchOpenRouterPricing } from './services/pricing.js';
import { useSession } from './hooks/useSession.js';
import { useKeyBindings } from './hooks/useKeyBindings.js';
import { useWizardActions } from './hooks/useWizardActions.js';
import { useHeader } from './hooks/useHeader.js';
import { startLogin, completeLogin } from './login.js';
import type { LoginSession } from './login.js';
import { runSlashCommand } from './commands.js';
import { describeUpdate, currentVersion } from './update-check.js';
import type { UpdateInfo } from './update-check.js';
import { ConfigService } from './services/config-service.js';
import { useConfig } from './hooks/useConfig.js';
import { toNamedAgents, toSafetyAgentConfig } from './services/settings.js';
import type { RuntimeMode } from './services/settings.js';
import { completeSlash } from './slashCommands.js';
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
   * The one owner of configuration: both files, their merge, and every write.
   *
   * Everything that used to arrive as a separate snapshot prop — the saved
   * hosts, the saved keys, the provider list, the MCP servers, the resolved
   * settings and the startup warnings — is read from here instead. Those props
   * were copies taken at startup, and a copy is a thing that can disagree with
   * the file after a write. See services/config-service.ts.
   *
   * Optional only so a test can render the App without one; it builds its own
   * against `workspaceRoot` in that case.
   */
  config?: ConfigService;
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
  config: configProp,
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

  // One service per workspace, and one snapshot of it per render. `snapshot`
  // changes identity only when a file does, so a write re-renders and nothing
  // else does.
  const config = useMemo(
    () => configProp ?? new ConfigService(workspaceRoot),
    [configProp, workspaceRoot],
  );
  const savedConfig = useConfig(config);
  const settings = savedConfig.settings;

  // The stored endpoints as the views are allowed to see them: enough to name
  // one and to show where it points, and deliberately not its key. A view needs
  // to *identify* an endpoint; `config.credentialsFor` is how the wizard asks
  // what is stored for the one the user landed on.
  const endpoints = useMemo(
    () => savedConfig.providers.map(({ provider, name, host }) => ({ provider, name, host })),
    [savedConfig],
  );
  // Named endpoints get their own row in the provider list, since "openai-compatible"
  // three times over tells the user nothing about which server is which.
  const customProviders = useMemo(
    () => endpoints.flatMap(e => (e.name ? [{ name: e.name, host: e.host }] : [])),
    [endpoints],
  );

  const [input, setInput] = useState('');
  const [pendingPrompts, setPendingPrompts] = useState<string[]>([]);
  const [activity, setActivity] = useState<Activity>('idle');
  const [metrics, setMetrics] = useState<ActivityMetrics>({});
  const [mode, setMode] = useState<Mode>(
    agentProfile.model ? { type: 'idle' } : { type: 'setup', tier: 'deep', chain: true },
  );
  const [steering, setSteering] = useState(false);
  // Both mirror the engine, which stays the source of truth: `session.light`
  // and `session.safetyLevel` are what actually apply. These exist so the
  // header can be reprinted later (a model switch, `/clear`, a resize replay)
  // still showing what this session is really doing. They start from the
  // resolved settings rather than a fixed default, because both are persisted.
  const [safetyLevel, setSafetyLevelState] = useState<SafetyLevel>(settings.safetyLevel);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(settings.runtime);
  const [booting, setBooting] = useState(Boolean(agentProfile.model) && animate);

  const prefs = usePreferences();
  const transcript = useTranscript();
  const approvals = useApprovals();
  const questions = useQuestions();
  const pasteBuffer = usePasteBuffer();
  const attachments = useAttachments();

  // ── the header row ─────────────────────────────────────────────────────────
  const { headerMeta, headerMessage, sessionTagline } = useHeader({
    workspaceRoot, safetyLevel, runtimeMode, enableWebSearch, enableGitHub, transcript,
  });

  // ── engine client ──────────────────────────────────────────────────────────
  const client = useEngineClient(useTranscriptPort({
    transcript, approvals, questions, setSteering, prefs, setActivity, setMetrics, setMode,
  }));

  // The stored judge names a provider and model but never a key, so it has to
  // be authenticated at load time exactly like the main model. Without this a
  // level-3 judge comes up unreachable, and while an unreachable judge falls
  // back to asking the human rather than approving, that is not the gate that
  // was configured. `toSafetyAgentConfig` owns the precedence.
  const { session, activeProfile, fastProfile, applyProfiles, stageProfile, persistSafety } =
    useSession({
      workspaceRoot, config, agentProfile, fastProfile: initialFastProfile,
      contextAgentProfile, plannerAgentProfile, reviewerAgentProfile,
      enableGitHub, enableWebSearch, maxTokens,
      mcpServers: savedConfig.mcpServers,
      namedAgents: toNamedAgents(savedConfig.agents, config.credentialsFor),
      client, SessionCtor,
      light: settings.runtime === 'light',
      // Both derived from the one saved mode, so a session cannot come up
      // lean and swarming at once.
      swarm: settings.runtime === 'agentic',
      safetyLevel: settings.safetyLevel,
      safetyAgent: settings.safetyAgent
        ? toSafetyAgentConfig(settings.safetyAgent, { mainProfile: agentProfile, keyFor: config.keyFor })
        : undefined,
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

  // A save that fails is a fact about this session, so it belongs in the
  // transcript rather than in a swallowed `.catch`. The service is built before
  // the UI exists, so it starts out reporting to stderr and is redirected here.
  useEffect(() => {
    config.reportErrorsTo(message => transcript.push('error', message));
  }, [config]); // eslint-disable-line react-hooks/exhaustive-deps

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
    for (const warning of savedConfig.warnings) {
      transcript.push('info', warning);
    }
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
    transcript.push('info', next.cascaded > 0
      ? `${APPROVAL_LABELS[decision]} (${next.cascaded + 1} matching actions)`
      : APPROVAL_LABELS[decision]);
    setMode(next.show ? { type: 'approval', request: next.show } : { type: 'running' });
  };

  // ── wizard completion (setup / mcp add / safety judge) ─────────────────────
  const wizardActions = useWizardActions({
    session, config, transcript, activeProfile, fastProfile,
    applyProfiles, stageProfile, persistSafety, setMode, setSafetyLevelState,
  });
  const { persistMcp } = wizardActions;

  // ── submitting ─────────────────────────────────────────────────────────────
  const handleSubmit = (value: string) => {
    // While a turn is active, capture the prompt explicitly instead of dropping it
    // or starting a concurrent engine run with ambiguous ordering.
    //
    // `session.busy` is asked as well as the mode, because the two can disagree:
    // a turn the *engine* started — a finished background job waking the agent —
    // claims the session while this UI is still sitting at an idle prompt. Going
    // by the mode alone, that prompt went to `run`, came back as "A task is
    // already running." and was lost.
    if (mode.type === 'running' || mode.type === 'approval'
      || (mode.type === 'idle' && session?.busy === true)) {
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
        mcpWarnings: savedConfig.mcpWarnings,
        applyProfiles, activeProfile, quit,
        onRuntimeModeChange: (mode, scope) => {
          setRuntimeMode(mode);
          void config.updateSettings(current => ({ ...current, runtime: mode }), scope)
            .then(saved => {
              // A global write that this repo already overrides would otherwise
              // look like it did nothing the next time the user opens it here.
              if (!saved || scope !== 'global') return;
              // Read after the write, from the service, so this is what the file
              // says now rather than what it said when the App mounted.
              const pinned = config.snapshot().projectSettings.runtime;
              if (pinned && pinned !== mode) {
                transcript.push('info',
                  `note: this workspace pins runtime "${pinned}" in .marshall/config.json, `
                  + `which still wins here. Run /runtime ${mode} to change it too.`);
              }
            });
        },
        startLogin: startLoginCtor,
        onSafetyLevelChange: (level) => {
          setSafetyLevelState(level);
          // The whole judge config, not just its profile — `kind` and
          // `maxOutputTokens` have to survive the round trip.
          persistSafety(level, session?.safetyAgent);
        },
        agents: savedConfig.agents,
        onAgentsChanged: wizardActions.applyAgents,
        repairConfig: () => config.repair(),
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
    // A turn ending is not the same as the session going free: the engine picks
    // up finished background jobs in the same breath, so the next turn can
    // already own the session by the time this runs. Leave the queue alone and
    // wait for that turn to end too, rather than sending the head prompt into a
    // refusal or rotating it to the back of the queue.
    if (session?.busy) return;
    const [next, ...rest] = pendingPrompts;
    if (!next) return;
    setPendingPrompts(rest);
    setActivity('idle');
    handleSubmit(next);
  // handleSubmit is intentionally event-local; this effect reacts only to lifecycle completion.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity, pendingPrompts]);

  // ── render ─────────────────────────────────────────────────────────────────
  //
  // The wizard renders *inside* the tree below rather than replacing it. Ink's
  // <Static> keeps the count of rows it has already emitted in component state,
  // so unmounting it — which an early return here used to do — resets that
  // count to zero and makes it re-emit the whole transcript on the way back.
  // That was the duplicate banner after a model switch.
  const wizardActive = mode.type === 'settings-menu' || mode.type === 'mcp-setup'
    || mode.type === 'team-setup' || mode.type === 'setup' || mode.type === 'safety-setup';
  const wizard = (
    <Wizard
      mode={mode}
      setMode={setMode}
      runtimeMode={runtimeMode}
      safetyLevel={safetyLevel}
      activeProfile={activeProfile}
      fastProfile={fastProfile}
      endpoints={endpoints}
      customProviders={customProviders}
      session={session}
      savedConfig={savedConfig}
      config={config}
      transcript={transcript}
      setRuntimeMode={setRuntimeMode}
      setSafetyLevelState={setSafetyLevelState}
      SetupCtor={SetupCtor}
      actions={wizardActions}
    />
  );

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
          tagline={sessionTagline}
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
      {!booting && accepting && !wizardActive && (!modal || panel.showPrompt) && (
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
