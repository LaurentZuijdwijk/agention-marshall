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
import { loadConfig, savedHosts, loadMcpServers, loadMcpWarnings } from './services/config-store.js';

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

let profiles;
try {
  profiles = resolveProfiles(flags, savedConfig);
} catch (err) {
  if (!(err instanceof StartupError)) throw err;
  console.error(err.message);
  process.exit(1);
}

installCrashLogging(workspaceRoot);

const updatePromise = checkForUpdate();

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
    registerRedraw={fn => { replayTranscript = fn; }}
    savedHosts={savedHosts(savedConfig)}
    mcpServers={loadMcpServers(workspaceRoot)}
    mcpWarnings={loadMcpWarnings(workspaceRoot)}
  />,
  // The App owns Ctrl-C so it can interrupt a running task before quitting;
  // ink's built-in handler would unmount without cancelling anything.
  { exitOnCtrlC: false },
);

await inkInstance.waitUntilExit();

// Show the update notice after the TUI exits so it doesn't interfere with rendering.
const notice = await Promise.race([
  updatePromise,
  new Promise<null>(resolve => setTimeout(() => resolve(null), 500)),
]);
if (notice) process.stderr.write(`\n${notice}\n`);

// Leave explicitly. An aborted LLM request or the update check above can leave
// a socket pending, and node would sit there indefinitely with the UI already
// torn down. Everything we needed to write has been written by this point.
process.exit(0);
