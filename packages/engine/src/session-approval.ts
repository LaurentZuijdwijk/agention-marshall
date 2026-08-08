import type {
  ApprovalDecision, ApprovalRequest, ApprovalDecider, ApprovalFn,
} from '@agentionai/marshall-tools';
import { createSafetyAgentDecider } from './safety-agent.js';
import type { EngineConfig } from './config.js';
import type { ClientInterface } from './types.js';

/**
 * The gate that answers "may this tool call run?".
 *
 * Owns the session's consent state — the always-approve list and the in-flight
 * coalescing map — so nothing outside has to know either exists. Built once per
 * session and never rebuilt: the always-approve list is consent given for the
 * session, so a model switch must not clear it.
 */

/**
 * Walk an approval chain until something has an opinion.
 *
 * Denies if every link defers. That can only happen if the chain is
 * misconfigured — the human link never defers — and on a gate whose whole job
 * is to withhold consent, the safe answer to "nobody decided" is no.
 */
async function runChain(chain: ApprovalDecider[], req: ApprovalRequest): Promise<ApprovalDecision> {
  for (const decide of chain) {
    const verdict = await decide(req);
    if (verdict !== 'defer') return verdict;
  }
  return 'deny';
}

export interface ApprovalGate {
  /** Hand this to `ToolConfig.approval`. */
  readonly approve: ApprovalFn;
  /** Tools the user granted "always" this session, for anyone wanting to show them. */
  readonly alwaysApproved: ReadonlySet<string>;
  /** `/clear` — consent does not outlive the conversation it was given in. */
  reset(): void;
}

export interface ApprovalGateDeps {
  /**
   * A getter, not a value: the session replaces its config wholesale on every
   * `/safety` and `/model` change, and the chain is built from `safetyLevel`.
   * A snapshot here would pin the gate to whatever level the session started at.
   */
  getConfig: () => EngineConfig;
  client: ClientInterface;
  log: (line: string) => void;
}

export function createApprovalGate({ getConfig, client, log }: ApprovalGateDeps): ApprovalGate {
  const alwaysApproved = new Set<string>();
  /**
   * In-flight approval promises keyed by tool name. Parallel tool calls for the
   * same tool all run their approval gate at once, so without this, choosing
   * "always" only applies to whichever one reaches the check first — the rest
   * still prompt. Coalescing them means one user decision answers the whole batch.
   */
  const pendingApprovals = new Map<string, Promise<ApprovalDecision>>();

  const askHuman = async (req: ApprovalRequest): Promise<ApprovalDecision> => {
    const decision = await client.requestApproval(req);
    if (decision === 'always') {
      alwaysApproved.add(req.toolName);
      log(`TOOL ${req.toolName} approved (always — added to session list)`);
    } else {
      log(`TOOL ${req.toolName} ${decision === 'approve' ? 'approved' : 'denied'}`);
    }
    return decision;
  };

  /**
   * The ordered chain that answers an approval request.
   *
   * Each decider returns a decision or `'defer'`, and the first non-defer wins;
   * asking the human is simply the last link, the one that never defers. Written
   * as a chain rather than an `if` ladder because the automated reviewer slots in
   * between these two, and no tool has to know it exists. That is also why
   * ApprovalRequest carries structured `input` and `source`: a reviewer needs
   * the arguments and the provenance, not the prose meant for a human.
   *
   * Safety level 3 is that reviewer: `createSafetyAgentDecider` approves outright
   * on a clear "safe" verdict, and otherwise defers to the human (annotating the
   * request on "unsafe" so they see why and can override it) — see its own doc
   * comment. Level 1 skips the human link entirely; level 2 (the default) is
   * this chain with no automated link at all.
   *
   * Rebuilt per request rather than per turn, so a `/safety` change mid-turn
   * takes effect on the very next call rather than the next turn. Cheap enough
   * to do: it is array construction plus one closure.
   */
  const buildChain = (): ApprovalDecider[] => {
    const config = getConfig();
    return [
      // Session "always allow", by tool name.
      async (req) => {
        if (!alwaysApproved.has(req.toolName)) return 'defer';
        log(`TOOL ${req.toolName} auto-approved (always)`);
        return 'approve';
      },
      ...(config.safetyLevel === 1
        ? [async () => 'approve' as const]
        : []),
      ...(config.safetyLevel === 3 && config.safetyAgent
        ? [createSafetyAgentDecider(config.safetyAgent, {
            log,
            onVerdict: (verdict) => client.onOutput({ type: 'safety-verdict', ...verdict }),
          })]
        : []),
      askHuman,
    ];
  };

  return {
    alwaysApproved,
    approve: async (req) => {
      const inFlight = pendingApprovals.get(req.toolName);
      if (inFlight) return inFlight;

      const decision = runChain(buildChain(), req);
      pendingApprovals.set(req.toolName, decision);
      void decision.finally(() => pendingApprovals.delete(req.toolName));
      return decision;
    },
    reset: () => {
      alwaysApproved.clear();
      pendingApprovals.clear();
    },
  };
}
