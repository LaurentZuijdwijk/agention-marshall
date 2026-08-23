import { useState } from 'react';
import { homedir } from 'node:os';
import type { AgentProfile, SafetyLevel } from '@agentionai/marshall-engine';
import { shortenPath } from '../format.js';
import { STARTUP_TAGLINES } from '../view/Banner.js';
import type { HeaderMeta } from '../view/Banner.js';
import { pickPaletteVariant } from '../view/theme.js';
import type { RuntimeMode } from '../services/settings.js';
import { SAFETY_LEVEL_LABELS } from '../slashCommands.js';
import { currentVersion } from '../update-check.js';
import type { Message } from '../view/message.js';
import type { Transcript } from './useTranscript.js';

export interface UseHeaderOptions {
  workspaceRoot: string;
  safetyLevel: SafetyLevel;
  runtimeMode: RuntimeMode;
  enableWebSearch: boolean;
  enableGitHub: boolean;
  privateMode?: boolean;
  transcript: Transcript;
}

/**
 * The header row: the banner's static replacement and every `header` message
 * pushed after a model switch. The tagline and wordmark palette are each
 * chosen once here so the animated banner and the static header that
 * replaces it settle on the same sentence and colours rather than rolling
 * them twice.
 */
export function useHeader({
  workspaceRoot, safetyLevel, runtimeMode, enableWebSearch, enableGitHub, privateMode, transcript,
}: UseHeaderOptions) {
  const [sessionTagline] = useState(
    () => STARTUP_TAGLINES[Math.floor(Math.random() * STARTUP_TAGLINES.length)],
  );
  const [sessionPalette] = useState(() => pickPaletteVariant());

  const headerMeta = (deep: AgentProfile, fast?: AgentProfile): HeaderMeta => ({
    provider: deep.provider,
    providerName: deep.name,
    model: deep.model ?? 'default',
    dir: shortenPath(workspaceRoot, homedir()),
    fastModel: fast?.model,
    fastProvider: fast?.provider,
    fastProviderName: fast?.name,
    safety: SAFETY_LEVEL_LABELS[safetyLevel],
    version: currentVersion,
    runtime: runtimeMode,
    webSearch: enableWebSearch,
    github: enableGitHub,
    private: privateMode,
  });

  const headerMessage = (deep: AgentProfile, fast?: AgentProfile, compact = false): Message =>
    ({
      key: transcript.nextKey(), role: 'header', content: '', meta: headerMeta(deep, fast), compact,
      tagline: sessionTagline, palette: sessionPalette.name,
    });

  return { headerMeta, headerMessage, sessionTagline, sessionPalette };
}
