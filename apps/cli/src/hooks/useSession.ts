import { useRef, useState } from 'react';
import { Session } from '@agentionai/marshall-engine';
import type {
  AgentProfile, ClientInterface, McpServerConfig, NamedAgent, SafetyAgentConfig, SafetyLevel,
} from '@agentionai/marshall-engine';
import type { ConfigService } from '../services/config-service.js';
import { toSavedSafetyAgent } from '../services/settings.js';

/**
 * Owns the engine Session and the two model tiers it was built from.
 *
 * The Session is not React state: it is a long-lived object the engine holds
 * onto, and rebuilding it is an explicit act (the setup wizard finished, or
 * `/model off` dropped the fast tier), never a side effect of rendering.
 *
 * It owns no configuration. The saved hosts and keys used to be mirrored here
 * in React state and updated alongside the write, which meant two answers to
 * "what is stored" that agreed only as long as every writer remembered to
 * update both. `ConfigService` is the single answer now.
 */
export interface SessionController {
  session: Session | null;
  /** The deep tier currently in use. */
  activeProfile: AgentProfile;
  fastProfile?: AgentProfile;
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
  /** The one owner of what is on disk. Every persist here goes through it. */
  config: ConfigService;
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
  /** Servers loaded from the global config, connected at session start. */
  mcpServers?: McpServerConfig[];
  /** The saved `/team` roster, credentials already resolved — see
   *  `toNamedAgents`. A later `/team` change applies live via
   *  `session.setNamedAgents`, not by rebuilding. */
  namedAgents?: NamedAgent[];
  client: ClientInterface;
  /** Fired after a rebuild, so the caller can restart its transcript. */
  onProfilesChanged(deep: AgentProfile, fast: AgentProfile | undefined): void;
  SessionCtor?: typeof Session;
}

export function useSession(options: UseSessionOptions): SessionController {
  const {
    workspaceRoot, config, agentProfile, fastProfile: initialFast,
    contextAgentProfile, plannerAgentProfile, reviewerAgentProfile,
    enableGitHub, enableWebSearch, maxTokens, light, swarm,
    client, onProfilesChanged, SessionCtor = Session, safetyLevel, safetyAgent,
  } = options;

  const [activeProfile, setActiveProfile] = useState<AgentProfile>(agentProfile);
  const [fastProfile, setFastProfile] = useState<AgentProfile | undefined>(initialFast);

  const build = (deep: AgentProfile, fast: AgentProfile | undefined) =>
    new SessionCtor({
      agent: deep,
      models: { deep, fast },
      workspaceRoot, enableGitHub, enableWebSearch, maxTokens, light, swarm,
      mcpServers: options.mcpServers,
      namedAgents: options.namedAgents,
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

  const persistSafety = (level: SafetyLevel, agent?: SafetyAgentConfig) => {
    // YOLO (level 1) is session-only and is never written. Returning early
    // also leaves any previously pinned level alone, which is the point: yolo
    // is a decision about this session, not about the next one.
    if (level === 1) return;
    void config.updateSettings(current => ({
      ...current,
      safetyLevel: level,
      // Passed through, not merged: dropping the judge is how a gate that no
      // longer has one stops claiming it does. `applySettings` removes the key
      // when this is undefined.
      safetyAgent: agent ? toSavedSafetyAgent(agent) : undefined,
    }));
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
    // The write is what updates the wizard's idea of the stored host and key:
    // the service re-reads the file and notifies, so reopening the wizard in
    // this same session offers what was just entered without anything here
    // keeping a second copy of it.
    void config.saveProfiles(deep, fast);
  };

  return {
    session: sessionRef.current,
    activeProfile,
    fastProfile,
    applyProfiles,
    stageProfile: setActiveProfile,
    persistSafety,
  };
}
