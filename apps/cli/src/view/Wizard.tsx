import React from 'react';
import { Box } from 'ink';
import type { AgentProfile, Provider, SafetyLevel, Session } from '@agentionai/marshall-engine';
import type { Mode, SetMode } from '../mode.js';
import type { ConfigService, ConfigSnapshot } from '../services/config-service.js';
import type { RuntimeMode } from '../services/settings.js';
import type { Transcript } from '../hooks/useTranscript.js';
import type { useWizardActions } from '../hooks/useWizardActions.js';
import { currentVersion } from '../update-check.js';
import { SettingsMenu } from './setupMenu/SettingsMenu.js';
import { McpSetup } from './McpSetup.js';
import { TeamSetup } from './TeamSetup.js';

export interface WizardProps {
  mode: Mode;
  setMode: SetMode;
  runtimeMode: RuntimeMode;
  safetyLevel: SafetyLevel;
  activeProfile: AgentProfile;
  fastProfile?: AgentProfile;
  endpoints: { provider: string; name?: string; host?: string }[];
  customProviders: { name: string; host?: string }[];
  session: Session | null;
  savedConfig: ConfigSnapshot;
  config: ConfigService;
  transcript: Transcript;
  setRuntimeMode(mode: RuntimeMode): void;
  setSafetyLevelState(level: SafetyLevel): void;
  SetupCtor: React.ComponentType<any>;
  actions: ReturnType<typeof useWizardActions>;
}

/**
 * The four wizards (`/setup`, `/mcp add`, `/model`, `/safety agentic`)
 * rendered *inside* the tree below the transcript rather than replacing it.
 * Ink's `<Static>` keeps the count of rows it has already emitted in
 * component state, so unmounting it — which an early return in `App` used to
 * do — resets that count to zero and re-emits the whole transcript on the way
 * back. That was the duplicate banner after a model switch.
 */
export function Wizard({
  mode, setMode, runtimeMode, safetyLevel, activeProfile, fastProfile,
  endpoints, customProviders, session, savedConfig, config, transcript,
  setRuntimeMode, setSafetyLevelState, SetupCtor, actions,
}: WizardProps) {
  if (mode.type === 'settings-menu') {
    return (
      <Box padding={1}>
        <SettingsMenu
          scope={mode.scope}
          runtime={runtimeMode}
          safetyLevel={safetyLevel}
          deepModel={{ provider: activeProfile.provider, model: activeProfile.model }}
          fastModel={fastProfile ? { provider: fastProfile.provider, model: fastProfile.model } : undefined}
          providers={endpoints}
          // The live connections, not the file: a server added this session is
          // connected but not yet in the snapshot the menu was opened with.
          mcpServers={session?.mcpServers() ?? savedConfig.mcpServers}
          onMcpAdd={() => setMode({ type: 'mcp-setup' })}
          onMcpRemove={server => actions.removeMcpServer(server.name)}
          onProviderAdd={() => setMode({ type: 'setup', tier: 'deep', chain: false })}
          onProviderRemove={entry => {
            // Only on a write that landed: the service reports the failure
            // itself, and "removed" next to "could not save" is worse than
            // either alone.
            void config.removeProvider(entry).then(saved => {
              if (saved) transcript.push('info', `removed provider: ${entry.name ?? entry.provider}`);
            });
          }}
          onRuntimeChange={(next, scope) => {
            setRuntimeMode(next);
            session?.setRuntime(next);
            void config.updateSettings(current => ({ ...current, runtime: next }), scope)
              .then(saved => {
                if (saved) transcript.push('info', `runtime: ${next} (${scope === 'global' ? 'global' : 'local'})`);
              });
          }}
          onSafetyChange={level => {
            setSafetyLevelState(level);
            if (level === 3) setMode({ type: 'safety-setup' });
            else {
              session?.setSafetyLevel(level);
              actions.persistSafety(level, session?.safetyAgent);
              transcript.push('info', `safety: ${level === 1 ? 'yolo (session only)' : 'default'}`);
              setMode({ type: 'idle' });
            }
          }}
          onModels={tier => setMode({ type: 'setup', tier, chain: false })}
          onUpdate={() => transcript.push('info', `current version: ${currentVersion} — use /update to check for updates`)}
          onExit={() => setMode({ type: 'idle' })}
        />
      </Box>
    );
  }

  if (mode.type === 'mcp-setup') {
    return (
      <Box padding={1}>
        <McpSetup
          existing={session?.mcpState().map(s => s.name) ?? []}
          onComplete={actions.handleMcpAdd}
          onExit={() => setMode({ type: 'idle' })}
        />
      </Box>
    );
  }

  if (mode.type === 'team-setup') {
    return (
      <Box padding={1}>
        <TeamSetup
          existing={savedConfig.agents.map(a => a.name)}
          credentials={config.credentialsFor}
          onComplete={actions.handleTeamAdd}
          onExit={() => setMode({ type: 'idle' })}
        />
      </Box>
    );
  }

  if (mode.type === 'setup') {
    return (
      <Box padding={1}>
        <SetupCtor
          key={mode.tier}
          tier={mode.tier}
          customProviders={customProviders}
          deepLabel={activeProfile.model}
          // The fast tier usually lives on the same server as deep, so seed it
          // from whichever profile is closest to what the user is about to pick.
          initial={actions.seedProfile(mode.tier)}
          credentials={config.credentialsFor}
          onComplete={(p: Provider | null, m: string | null, h?: string, k?: string, n?: string) =>
            actions.handleSetupComplete(mode.tier, mode.chain, p, m, h, k, n)}
          onExit={() => setMode({ type: 'idle' })}
        />
      </Box>
    );
  }

  if (mode.type === 'safety-setup') {
    return (
      <Box padding={1}>
        <SetupCtor
          title="safety judge model"
          blurb='reviews each tool call before it runs — a "safe" verdict skips your approval, "unsafe" still asks you, with its reasoning attached'
          credentials={config.credentialsFor}
          onComplete={actions.handleSafetySetupComplete}
          onExit={() => setMode({ type: 'idle' })}
        />
      </Box>
    );
  }

  return null;
}
