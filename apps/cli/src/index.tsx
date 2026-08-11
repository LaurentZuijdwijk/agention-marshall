// ── entry point ───────────────────────────────────────────────────────────────
//
// Startup order matters and is the only thing this file expresses: parse args,
// find the workspace, load its env, resolve the model profiles, then hand the
// lot to the App. Each step lives in ./startup.

import React from 'react';
import { render } from 'ink';
import { App } from './App.js';
import { parseCliArgs, helpText } from './startup/args.js';
import { resolveWorkspaceRoot, loadEnvFiles } from './startup/workspace.js';
import { resolveProfiles, StartupError } from './startup/profiles.js';
import { installCrashLogging } from './startup/crash-log.js';
import { installResizeRedraw } from './view/resize.js';
import { checkForUpdate } from './update-check.js';
import { loadConfig, savedHosts, savedKeys, loadMcpServers, loadMcpWarnings, projectSecretWarnings } from './services/config-store.js';
import { readSettings, resolveSettings, settingsWarnings } from './services/settings.js';

const flags = parseCliArgs();

if (flags.help) {
  console.log(helpText());
  process.exit(0);
}

const workspaceRoot = resolveWorkspaceRoot(flags.workspace);
loadEnvFiles(workspaceRoot);

// Saved config from .marshall/config.json, overridden by CLI flags. The flat
// provider/model/host keys are the pre-tier format and are still read as the
// deep tier, so existing workspaces keep working untouched.
const savedConfig = loadConfig(workspaceRoot);

// Non-secret settings come through one reader, resolved once here, so nothing
// downstream has to know which of the two config files a value came from or
// whether a flag beat it. See services/settings.ts.
const settings = resolveSettings(readSettings(savedConfig), { light: flags.light });
const configWarnings = [...settingsWarnings(savedConfig), ...projectSecretWarnings(workspaceRoot)];

let profiles;
try {
  profiles = resolveProfiles(flags, savedConfig);
} catch (err) {
  if (!(err instanceof StartupError)) throw err;
  console.error(err.message);
  process.exit(1);
}

installCrashLogging(workspaceRoot);

// Started before render so the round trip overlaps with boot; the App shows the
// result as a transcript row once the banner is done.
const updateCheck = checkForUpdate();

// Start with a clean visible terminal, like Ctrl-L, so the shell prompt and
// previous command output do not sit above the session banner. Keep scrollback
// intact and avoid emitting control codes when stdout is redirected.
if (process.stdout.isTTY) {
  process.stdout.write('\u001B[2J\u001B[H');
}

let inkInstance: ReturnType<typeof render> | undefined;
let replayTranscript: () => void = () => {};
installResizeRedraw(() => inkInstance, () => replayTranscript());

inkInstance = render(
  <App
    workspaceRoot={workspaceRoot}
    agentProfile={profiles.agentProfile}
    fastProfile={profiles.fastProfile}
    contextAgentProfile={profiles.contextAgentProfile}
    plannerAgentProfile={profiles.plannerAgentProfile}
    reviewerAgentProfile={profiles.reviewerAgentProfile}
    enableGitHub={flags.github}
    enableWebSearch={flags.webSearch}
    maxTokens={profiles.maxTokens}
    settings={settings}
    savedHosts={savedHosts(savedConfig)}
    savedKeys={savedKeys(savedConfig)}
    mcpServers={loadMcpServers(workspaceRoot)}
    mcpWarnings={loadMcpWarnings(workspaceRoot)}
    configWarnings={configWarnings}
    updateCheck={updateCheck}
    registerRedraw={fn => { replayTranscript = fn; }}
  />,
  // The App owns Ctrl-C so it can interrupt a running task before quitting;
  // ink's built-in handler would unmount without cancelling anything.
  { exitOnCtrlC: false },
);

await inkInstance.waitUntilExit();

// Leave explicitly. An aborted LLM request or the update check can leave
// a socket pending, and node would sit there indefinitely with the UI already
// torn down. Everything we needed to write has been written by this point.
process.exit(0);
