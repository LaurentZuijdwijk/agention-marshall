import { useRef, useState } from 'react';
import { Session } from '@agentionai/marshall-engine';
import type { AgentProfile, ClientInterface, Provider, McpServerConfig, SafetyAgentConfig, SafetyLevel } from '@agentionai/marshall-engine';
import { saveConfig } from '../services/config-store.js';
import { saveSettings, toSavedSafetyAgent } from '../services/settings.js';

/**
 * Owns the engine Session and the two model tiers it was built from.
 *
 * The Session is not React state: it is a long-lived object the engine holds
 * onto, and rebuilding it is an explicit act (the setup wizard finished, or
 * `/model off` dropped the fast tier), never a side effect of rendering.
 */
export interface SessionController {
  session: Session | null;
  /** The deep tier currently in use. */
  activeProfile: AgentProfile;
  fastProfile?: AgentProfile;
  /** Per-provider last-used host, for re-seeding the wizard on a switch. */
  savedHosts: Record<string, string | undefined>;
  /** Per-provider stored API key, so the wizard can be confirmed with enter. */
  savedKeys: Record<string, string | undefined>;
  /** Rebuild the session on both tiers and persist them. */
  applyProfiles(deep: AgentProfile, fast: AgentProfile | undefined): void;
  /**
   * Remember a deep pick without starting a session — the first-run flow, which
   * asks for the fast tier before anything is built.
   */
  stageProfile(deep: AgentProfile): void;
  persistSafety(level: SafetyLevel, agent?: SafetyAgentConfig): void;
}

export interface UseSessionOptions {
  workspaceRoot: string;
  agentProfile: AgentProfile;
  fastProfile?: AgentProfile;
  contextAgentProfile?: AgentProfile;
  plannerAgentProfile?: AgentProfile;
  reviewerAgentProfile?: AgentProfile;
  enableGitHub?: boolean;
  enableWebSearch?: boolean;
  maxTokens?: number;
  light?: boolean;
  swarm?: boolean;
  safetyLevel?: SafetyLevel;
  safetyAgent?: SafetyAgentConfig;
  savedHosts?: Record<string, string | undefined>;
  savedKeys?: Record<string, string | undefined>;
  /** Servers loaded from the global config, connected at session start. */
  mcpServers?: McpServerConfig[];
  client: ClientInterface;
  /** Fired after a rebuild, so the caller can restart its transcript. */
  onProfilesChanged(deep: AgentProfile, fast: AgentProfile | undefined): void;
  SessionCtor?: typeof Session;
}

export function useSession(options: UseSessionOptions): SessionController {
  const {
    workspaceRoot, agentProfile, fastProfile: initialFast,
    contextAgentProfile, plannerAgentProfile, reviewerAgentProfile,
    enableGitHub, enableWebSearch, maxTokens, light, swarm,
    client, onProfilesChanged, SessionCtor = Session, safetyLevel, safetyAgent,
  } = options;

  const [activeProfile, setActiveProfile] = useState<AgentProfile>(agentProfile);
  const [fastProfile, setFastProfile] = useState<AgentProfile | undefined>(initialFast);
  // Starts from config and is updated as the user saves a new setup, so a later
  // provider switch in the same session re-seeds that provider's own host
  // instead of a single flat one.
  const [savedHosts, setSavedHosts] = useState<Record<string, string | undefined>>(
    options.savedHosts ?? {},
  );
  const [savedKeys, setSavedKeys] = useState<Record<string, string | undefined>>(
    options.savedKeys ?? {},
  );

  const build = (deep: AgentProfile, fast: AgentProfile | undefined) =>
    new SessionCtor({
      agent: deep,
      models: { deep, fast },
      workspaceRoot, enableGitHub, enableWebSearch, maxTokens, light, swarm,
      mcpServers: options.mcpServers,
      ...(safetyLevel ? { safetyLevel } : {}),
      ...(safetyAgent ? { safetyAgent } : {}),
      contextAgent: contextAgentProfile,
      plannerAgent: plannerAgentProfile,
      reviewerAgent: reviewerAgentProfile,
    }, client);

  // Lazily initialised by hand: `useRef(expr)` evaluates `expr` on *every* render
  // and throws all but the first away, so `new Session(...)` inline built a whole
  // Session — History, plugins, mkdir, sub-agents — per render. Any render loop
  // then turned into runaway memory use.
  const sessionRef = useRef<Session | null>(null);
  const initialised = useRef(false);
  if (!initialised.current) {
    initialised.current = true;
    // No model yet means the setup wizard is about to run; the session is built
    // when it completes.
    sessionRef.current = agentProfile.model ? build(agentProfile, initialFast) : null;
  }

  /**
   * Persist both tiers. Fire and forget — a failed write costs the user a re-run
   * of the wizard, not the session. The file shape lives in services/config-store
   * so the startup reader and this writer cannot drift.
   */
  const persist = (deep: AgentProfile, fast: AgentProfile | undefined) => {
    for (const profile of [deep, ...(fast ? [fast] : [])]) {
      if (profile.host !== undefined) {
        setSavedHosts(prev => ({ ...prev, [profile.provider as Provider]: profile.host }));
      }
      // Kept in step with the file we just wrote, so reopening the wizard in
      // this same session offers the key that was just entered.
      if (profile.apiKey) {
        setSavedKeys(prev => ({ ...prev, [profile.provider as Provider]: profile.apiKey }));
      }
    }
    void saveConfig(deep, fast).catch(() => {});
  };

  const persistSafety = (level: SafetyLevel, agent?: SafetyAgentConfig) => {
    // YOLO (level 1) is session-only and is never written. Returning early
    // also leaves any previously pinned level alone, which is the point: yolo
    // is a decision about this session, not about the next one.
    if (level === 1) return;
    void saveSettings(workspaceRoot, current => ({
      ...current,
      safetyLevel: level,
      // Passed through, not merged: dropping the judge is how a gate that no
      // longer has one stops claiming it does. `saveSettings` removes the key
      // when this is undefined.
      safetyAgent: agent ? toSavedSafetyAgent(agent) : undefined,
    })).catch(() => {});
  };

  const applyProfiles = (deep: AgentProfile, fast: AgentProfile | undefined) => {
    // Switch in place when there is a session to switch. Rebuilding it used to
    // be the whole implementation, which silently discarded the conversation,
    // the dedupe cache, running background jobs, MCP connections and the
    // always-approved list — none of which have anything to do with which model
    // is answering. Only the first run, before any model is chosen, constructs
    // one; from then on the session outlives every model choice.
    if (sessionRef.current) sessionRef.current.setProfiles(deep, fast);
    else sessionRef.current = build(deep, fast);
    setActiveProfile(deep);
    setFastProfile(fast);
    onProfilesChanged(deep, fast);
    persist(deep, fast);
  };

  return {
    session: sessionRef.current,
    activeProfile,
    fastProfile,
    savedHosts,
    savedKeys,
    applyProfiles,
    stageProfile: setActiveProfile,
    persistSafety,
  };
}
