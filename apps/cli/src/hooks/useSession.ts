import { useRef, useState } from 'react';
import { Session } from '@agentionai/marshall-engine';
import type { AgentProfile, ClientInterface, Provider } from '@agentionai/marshall-engine';
import { saveConfig } from '../services/config-store.js';

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
  /** Rebuild the session on both tiers and persist them. */
  applyProfiles(deep: AgentProfile, fast: AgentProfile | undefined): void;
  /**
   * Remember a deep pick without starting a session — the first-run flow, which
   * asks for the fast tier before anything is built.
   */
  stageProfile(deep: AgentProfile): void;
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
  savedHosts?: Record<string, string | undefined>;
  client: ClientInterface;
  /** Fired after a rebuild, so the caller can restart its transcript. */
  onProfilesChanged(deep: AgentProfile, fast: AgentProfile | undefined): void;
  SessionCtor?: typeof Session;
}

export function useSession(options: UseSessionOptions): SessionController {
  const {
    workspaceRoot, agentProfile, fastProfile: initialFast,
    contextAgentProfile, plannerAgentProfile, reviewerAgentProfile,
    enableGitHub, enableWebSearch, maxTokens,
    client, onProfilesChanged, SessionCtor = Session,
  } = options;

  const [activeProfile, setActiveProfile] = useState<AgentProfile>(agentProfile);
  const [fastProfile, setFastProfile] = useState<AgentProfile | undefined>(initialFast);
  // Starts from config and is updated as the user saves a new setup, so a later
  // provider switch in the same session re-seeds that provider's own host
  // instead of a single flat one.
  const [savedHosts, setSavedHosts] = useState<Record<string, string | undefined>>(
    options.savedHosts ?? {},
  );

  const build = (deep: AgentProfile, fast: AgentProfile | undefined) =>
    new SessionCtor({
      agent: deep,
      models: { deep, fast },
      workspaceRoot, enableGitHub, enableWebSearch, maxTokens,
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
    }
    void saveConfig(deep, fast).catch(() => {});
  };

  const applyProfiles = (deep: AgentProfile, fast: AgentProfile | undefined) => {
    setActiveProfile(deep);
    setFastProfile(fast);
    sessionRef.current = build(deep, fast);
    onProfilesChanged(deep, fast);
    persist(deep, fast);
  };

  return {
    session: sessionRef.current,
    activeProfile,
    fastProfile,
    savedHosts,
    applyProfiles,
    stageProfile: setActiveProfile,
  };
}
