// ── headless mode ─────────────────────────────────────────────────────────────
//
// `--message` runs one task non-interactively and exits: no Ink, no REPL, no
// human to approve a tool call. That last part is why it requires
// `--safety yolo` — the same gate `/safety yolo` opens interactively (see
// slashCommands.ts) — rather than silently assuming it. `default` and
// `agentic` both still end in "ask a human," which headless mode has none of.
//
// Built for scripting and for driving marshall from an external benchmark
// harness the way `bench/run.ts` already drives the engine directly.

import { Session } from '@agentionai/marshall-engine';
import type { ClientInterface, EngineConfig, OutputEvent } from '@agentionai/marshall-engine';
import { SAFETY_LEVEL_WORDS } from '../slashCommands.js';
import type { SafetyLevelWord } from '../slashCommands.js';
import type { CliFlags } from './args.js';
import type { ResolvedProfiles } from './profiles.js';

function isSafetyLevelWord(value: string): value is SafetyLevelWord {
  return value in SAFETY_LEVEL_WORDS;
}

/** Plain-text transcript to stdout — no ANSI, no Ink, just what happened. */
function makeClient(onError: () => void): ClientInterface {
  return {
    onOutput(event: OutputEvent) {
      switch (event.type) {
        case 'tool-call':
          process.stdout.write(`\n$ ${event.toolName} ${JSON.stringify(event.input)}\n`);
          break;
        case 'tool-result':
          process.stdout.write(`${event.result}\n`);
          break;
        case 'token':
          process.stdout.write(event.text);
          break;
        case 'response':
          process.stdout.write(`\n${event.text}\n`);
          break;
        case 'error':
          onError();
          process.stderr.write(`error: ${event.message}\n`);
          break;
        case 'interrupted':
          onError();
          process.stderr.write('interrupted\n');
          break;
        default:
          break;
      }
    },
    // Unreachable at safetyLevel 1: the always-approve link answers every
    // request before this would ever run. Kept only to satisfy the interface.
    async requestApproval() {
      return 'approve';
    },
  };
}

/** Runs `flags.message` to completion and returns the process exit code. */
export async function runHeadless(
  flags: CliFlags,
  workspaceRoot: string,
  profiles: ResolvedProfiles,
): Promise<number> {
  const word = flags.safety;
  if (word !== 'yolo') {
    if (word && !isSafetyLevelWord(word)) {
      console.error(`--safety "${word}" is not a recognised level (yolo, default, agentic).`);
    } else {
      console.error(
        '--message requires --safety yolo: every other level still asks a human to approve '
        + 'tool calls, and headless mode has none to ask.',
      );
    }
    return 1;
  }

  let sawError = false;
  const client = makeClient(() => { sawError = true; });

  const engineConfig: EngineConfig = {
    agent: profiles.agentProfile,
    models: { deep: profiles.agentProfile, fast: profiles.fastProfile },
    workspaceRoot,
    enableGitHub: flags.github,
    enableWebSearch: flags.webSearch,
    maxTokens: profiles.maxTokens,
    safetyLevel: SAFETY_LEVEL_WORDS.yolo.level,
    contextAgent: profiles.contextAgentProfile,
    plannerAgent: profiles.plannerAgentProfile,
    reviewerAgent: profiles.reviewerAgentProfile,
  };

  const session = new Session(engineConfig, client);
  await session.run(flags.message!);
  return sawError ? 1 : 0;
}
