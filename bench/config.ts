import type { AgentProfile, EngineConfig } from '@agentionai/marshall-engine';
import { DEFAULT_COMMAND_POLICY } from '@agentionai/marshall-tools';

/**
 * One row in the benchmark matrix: a main agent profile, plus an optional
 * separate profile for the `context` tool (fast reader/summarizer). Nothing
 * here is specific to any one provider or model — swap in whatever your
 * llamacpp/ollama/claude/etc. setup exposes.
 */
export interface BenchConfiguration {
  /** Short label used in the results table. */
  name: string;
  agent: AgentProfile;
  contextAgent?: AgentProfile;
  plannerAgent?: AgentProfile;
  reviewerAgent?: AgentProfile;
}

const LLAMACPP_HOST = process.env.MARSHALL_BENCH_HOST ?? 'http://192.168.1.248:8080';

/** Local llamacpp models currently available on the router, by role. */
const MODELS = {
  smart: 'Qwen3.6-27B-Uncensored-HauhauCS-Balanced-MTP-Q6_K_P',
  fast: 'Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive-Q6_K_P',
} as const;

function llamacpp(model: string): AgentProfile {
  return { provider: 'llamacpp', model, host: LLAMACPP_HOST };
}

/**
 * The configurations to benchmark. Edit this list to add/remove models or
 * providers — the harness itself has no model names in it.
 */
export const CONFIGURATIONS: BenchConfiguration[] = [
  { name: 'smart-solo', agent: llamacpp(MODELS.smart) },
  { name: 'fast-solo', agent: llamacpp(MODELS.fast) },
  { name: 'smart-main+fast-context', agent: llamacpp(MODELS.smart), contextAgent: llamacpp(MODELS.fast) },
  {
    name: 'fast-main+smart-planner+reviewer',
    agent: llamacpp(MODELS.fast),
    plannerAgent: llamacpp(MODELS.smart),
    reviewerAgent: llamacpp(MODELS.smart),
  },
];

export const BENCH_ENGINE_DEFAULTS: Partial<EngineConfig> = {
  enableGitHub: false,
  enableWebSearch: false,
  maxTokens: 8192,
  commandPolicy: DEFAULT_COMMAND_POLICY,
};

/** Per-task wall-clock budget before the harness gives up and marks it a timeout. */
export const TASK_TIMEOUT_MS = 5 * 60 * 1000;
