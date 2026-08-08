import { createHash } from 'node:crypto';
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

/**
 * What makes two in-flight requests the same question.
 *
 * The tool name alone is not enough, and getting this wrong is a consent bug
 * rather than a papercut. A model emitting three `write_file` calls in one
 * message is ordinary; keyed on the name they shared a single decision, so
 * approving the diff for one file silently wrote the other two, and denying one
 * denied all three. The arguments decide what is actually being asked, and the
 * caller decides who is asking — under delegation those are different consents
 * even for an identical action, and "who" means the specific agent instance,
 * not its role: fanned-out work puts several agents on one role at once.
 *
 * Hashed because `input` carries whole-file content for `write_file`, and the
 * key would otherwise hold a copy of it for the life of the request.
 */
function requestKey(req: ApprovalRequest): string {
  // Built field by field rather than serialising `caller` whole, so the key
  // never depends on property order. `id` is what separates two live agents on
  // the same role and model — without it they are one actor to this map.
  const identity = JSON.stringify([
    req.caller?.role ?? '',
    req.caller?.id ?? '',
    req.caller?.model ?? '',
    req.input ?? {},
  ]);
  return `${req.toolName}:${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
}

export function createApprovalGate({ getConfig, client, log }: ApprovalGateDeps): ApprovalGate {
  const alwaysApproved = new Set<string>();
  /**
   * In-flight approval promises, keyed by `requestKey`.
   *
   * Only genuinely identical questions coalesce: a model that repeats the exact
   * same call should not cost two prompts. Anything that differs in target or
   * caller is a separate decision and is asked separately.
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
      const key = requestKey(req);
      const inFlight = pendingApprovals.get(key);
      if (inFlight) return inFlight;

      const decision = runChain(buildChain(), req);
      pendingApprovals.set(key, decision);
      void decision.finally(() => pendingApprovals.delete(key));
      return decision;
    },
    reset: () => {
      alwaysApproved.clear();
      pendingApprovals.clear();
    },
  };
}
