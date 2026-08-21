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
import { installHttpTrace } from './startup/http-trace.js';
import { maybeRespawnForHeap } from './startup/heap-size.js';
import { installResizeRedraw } from './view/resize.js';
import { runHeadless } from './startup/headless.js';

// Long sessions can exhaust Node's old-space heap, which is only raised by a
// startup flag. Re-exec with --max-old-space-size when it isn't already set,
// then hand the terminal to the child. Must be the first thing this file does.
const heapChild = maybeRespawnForHeap();
if (heapChild) {
  await new Promise<void>(resolve => heapChild.on('close', resolve));
  process.exit(0);
}
import { checkForUpdate } from './update-check.js';
import { ConfigService } from './services/config-service.js';

const flags = parseCliArgs();

if (flags.help) {
  console.log(helpText());
  process.exit(0);
}

const workspaceRoot = resolveWorkspaceRoot(flags.workspace);
loadEnvFiles(workspaceRoot);
installHttpTrace(workspaceRoot);

// One owner for everything on disk: the two config files, their merge, and
// every write back to them. Constructed here and handed down, so nothing
// downstream has to know which file a value came from, whether a flag beat it,
// or how to persist a change to it. Errors are wired to the transcript by the
// App; before it renders there is nowhere to put them but stderr.
const config = new ConfigService(workspaceRoot, { light: flags.light },
  message => console.error(message));

// The flat provider/model/host keys are the pre-tier format and are still read
// as the deep tier, so existing workspaces keep working untouched.
let profiles;
try {
  profiles = resolveProfiles(flags, config.snapshot().config);
} catch (err) {
  if (!(err instanceof StartupError)) throw err;
  console.error(err.message);
  process.exit(1);
}

if (flags.message !== undefined) {
  const code = await runHeadless(flags, workspaceRoot, profiles);
  process.exit(code);
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
    config={config}
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
