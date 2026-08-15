import type { Dispatch, SetStateAction } from 'react';
import type { AgentProfile, McpServerConfig, Provider, SafetyAgentConfig, SafetyLevel, Session, Tier } from '@agentionai/marshall-engine';
import type { Mode } from '../mode.js';
import type { McpScope } from '../view/McpSetup.js';
import type { ConfigService } from '../services/config-service.js';
import type { SavedAgentEntry } from '../services/config-store.js';
import type { Transcript } from './useTranscript.js';
import { chosenProfile } from '../startup/profiles.js';
import { toNamedAgents } from '../services/settings.js';
import { G } from '../view/theme.js';

export interface UseWizardActionsOptions {
  session: Session | null;
  config: ConfigService;
  transcript: Transcript;
  activeProfile: AgentProfile;
  fastProfile?: AgentProfile;
  applyProfiles(deep: AgentProfile, fast: AgentProfile | undefined): void;
  stageProfile(deep: AgentProfile): void;
  persistSafety(level: SafetyLevel, agent?: SafetyAgentConfig): void;
  setMode: Dispatch<SetStateAction<Mode>>;
  setSafetyLevelState(level: SafetyLevel): void;
}

/**
 * What happens once a wizard (`/model`, `/mcp add`, the safety judge picker)
 * hands back a result.
 *
 * Split from the wizard's own rendering (`view/Wizard.tsx`) so the completion
 * logic — which touches the session, the config file and the transcript — can
 * be reasoned about without the four-way render branch around it.
 */
export function useWizardActions({
  session, config, transcript, activeProfile, fastProfile,
  applyProfiles, stageProfile, persistSafety, setMode, setSafetyLevelState,
}: UseWizardActionsOptions) {
  /** What to pre-fill the wizard with for the tier being chosen. */
  const seedProfile = (tier: Tier) => {
    const seed = tier === 'fast' ? (fastProfile ?? activeProfile) : activeProfile;
    return { provider: seed.provider, model: seed.model, host: seed.host };
  };

  // The engine session owns the *connections*; the config file only records the
  // definitions. So the session is always read for what to persist, and it must
  // have finished changing before it is read — see `removeMcpServer`.
  const persistMcp = (enableForProjectOnly?: string) => {
    if (!session) return;
    const servers = session.mcpServers().map(server =>
      server.name === enableForProjectOnly ? { ...server, enabled: false } : server);
    void config.saveMcpServers(servers);
    if (enableForProjectOnly) void config.enableProjectMcpServer(enableForProjectOnly);
  };

  /**
   * Disconnect a server and forget it, in that order.
   *
   * The order is the whole point: `removeMcpServer` is async, and persisting
   * before it settles writes back the list that still contains the server —
   * which is how a removed server came back on the next launch. `/mcp remove`
   * has always awaited it; the settings menu called the same pair the other way
   * round.
   */
  const removeMcpServer = (name: string) => {
    if (!session) return;
    session.removeMcpServer(name)
      .then(removed => {
        if (!removed) { transcript.push('error', `${name} is not a configured MCP server`); return; }
        persistMcp();
        transcript.push('info', `removed MCP server: ${name}`);
      })
      .catch((err: unknown) => transcript.push('error', err instanceof Error ? err.message : String(err)));
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

  // ── named agents (/team) ────────────────────────────────────────────────────
  //
  // Persisted and applied together — the settings menu's runtime/safety
  // changes do the same pair for the same reason: a subscriber that only saw
  // the write, or only the live session, would show the two disagreeing until
  // the next full sync.
  const applyAgents = (agents: SavedAgentEntry[]) => {
    void config.saveAgents(agents);
    session?.setNamedAgents(toNamedAgents(agents, config.credentialsFor));
  };

  // Same shape `describeAgentEntry` (commands.ts) lists it in, so `/team list`
  // afterwards reads as a continuation of this line, not a different format.
  const handleTeamAdd = (entry: SavedAgentEntry) => {
    const current = config.snapshot().agents;
    const existed = current.some(a => a.name === entry.name);
    applyAgents([...current.filter(a => a.name !== entry.name), entry]);
    const head = `${entry.name}  ${entry.provider}/${entry.model}`;
    const withToolset = entry.toolset ? `${head}  toolset: ${entry.toolset}` : head;
    transcript.push('info',
      `${existed ? 'updated' : 'added'} ${entry.description ? `${withToolset}  — ${entry.description}` : withToolset}`);
    setMode({ type: 'idle' });
  };

  // ── safety judge wizard (/safety agentic) ─────────────────────────────────
  //
  // Deliberately does not go through `applyProfiles`/`persist()`: that path
  // writes credentials to the global config, and the judge is persisted through
  // `persistSafety`, which strips the key and records only provider/model/host.
  const handleSafetySetupComplete = (
    provider: Provider | null,
    model: string | null,
    host?: string,
    apiKey?: string,
  ) => {
    if (provider && model && session) {
      const agent = { profile: { provider, model, host, ...(apiKey ? { apiKey } : {}) } };
      session.setSafetyAgent(agent);
      session.setSafetyLevel(3);
      persistSafety(3, agent);
      setSafetyLevelState(3);
      transcript.push('info', `safety: agentic — reviewing tool calls with ${provider}/${model}`);
    }
    setMode({ type: 'idle' });
  };

  const handleSetupComplete = (
    tier: Tier,
    chain: boolean,
    provider: Provider | null,
    model: string | null,
    host?: string,
    apiKey?: string,
    name?: string,
  ) => {
    // `activeProfile`, not the `agentProfile` prop, so a second switch in the
    // same session carries the effort just set rather than the one from boot
    // — the prop is fixed at mount, `activeProfile` tracks every switch since.
    // See `chosenProfile` for why only the effort carries over.
    const chosen = chosenProfile({ provider, model, host, apiKey, name },
      tier === 'deep' ? activeProfile : undefined);

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

  return {
    seedProfile, persistMcp, removeMcpServer, handleMcpAdd,
    handleSafetySetupComplete, handleSetupComplete, persistSafety,
    applyAgents, handleTeamAdd,
  };
}
