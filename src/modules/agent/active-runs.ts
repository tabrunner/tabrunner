import { createLogger } from "@/lib/logger";
import type { PlanApprovalPayload } from "@/shared/protocol";

const log = createLogger("runs");

/** Which client started the run — decides who may stop/steer it and how a
 *  conflict is worded. Only the owner's stop/inject commands touch a run.
 *  "schedule" is an alarm firing with nobody present: it carries the user's
 *  consent from when the schedule was created, not from a panel at run time. */
export type RunOwner = "panel" | "bridge" | "schedule";

/** The single live run slot. The injected queue lives here too, so both clients
 *  steer their own runs without any per-port state. */
export interface ActiveRun {
  conversationId: string;
  owner: RunOwner;
  controller: AbortController;
  /** Messages typed mid-run, drained by the loop at each tool boundary. */
  injectedQueue: { id: string; text: string }[];
  /**
   * What this run has spent, kept here for the same reason the parked plan is:
   * a panel that opens mid-run has seen none of the deltas, and without this
   * the only number it could show is the PREVIOUS run's, stamped on the
   * conversation at the last run's end. `contextTokens` is the conversation's
   * full usage — the thread's spend before this run plus this run's own total —
   * never smaller than the band's `input + output`.
   * `cost` is the running dollar estimate; absent until a call prices (a model
   * outside the pricing table never produces one — absent means unknown, not $0).
   */
  usage: { input: number; output: number; contextTokens: number; cost?: number };
  /**
   * A parked plan-approval prompt — resolved by the panel's plan_approval
   * command. `feedback` rides along on a revision request (a "no" that keeps
   * the run). The steps are kept, not just the resolver: a panel that closed
   * and came back has no memory of the card, and a parked run it cannot answer
   * is a run nobody can finish.
   */
  planApproval?: {
    /** Exactly what the panel is asked, wire-shaped — a reconnecting panel
     *  re-sends this untouched. */
    ask: PlanApprovalPayload;
    resolve: (approved: boolean, feedback?: string) => void;
  };
  /**
   * A parked elicitation from a remote MCP server — the plan gate's twin for
   * server-asked questions. One slot: a second request arriving while one is
   * parked gets an immediate decline rather than queueing behind it.
   */
  elicitation?: {
    requestId: string;
    resolve: (result: { action: "accept" | "decline"; value?: Record<string, unknown> }) => void;
  };
}

let active: ActiveRun | null = null;

/** Fired when the slot actually frees — the run queue pumps its next entry. */
const releaseListeners = new Set<() => void>();

/** Register a release listener; returns the unsubscribe. */
export function onRunReleased(cb: () => void): () => void {
  releaseListeners.add(cb);
  return () => releaseListeners.delete(cb);
}

export function getActiveRun(): ActiveRun | null {
  return active;
}

export type AcquireResult = { ok: true; run: ActiveRun } | { ok: false; active: ActiveRun };

/** Claim the single run slot — one agent loop drives one browser at a time,
 *  whatever client asked for it. The conflict carries the holder so the caller
 *  can say where the run is and how to stop it. */
export function acquireRun(conversationId: string, owner: RunOwner): AcquireResult {
  if (active) return { ok: false, active };
  const run: ActiveRun = {
    conversationId,
    owner,
    controller: new AbortController(),
    injectedQueue: [],
    usage: { input: 0, output: 0, contextTokens: 0 },
  };
  active = run;
  log.debug("run acquired", { conversationId, owner });
  return { ok: true, run };
}

/** Release the slot — but only if the handle is still the current one: a stop
 *  may have already released it and a newer run taken the slot while this one
 *  unwound. Listeners fire after the slot is visibly free, so a listener that
 *  starts the next run never sees its own release. */
export function releaseRun(run: ActiveRun): void {
  if (active !== run) return;
  active = null;
  for (const cb of releaseListeners) cb();
}

/** The panel's answer to a parked plan-approval prompt. Returns whether an
 *  answer actually landed — a no-op when nothing is parked (a bridge run
 *  auto-approves) so a stale or doubled answer neither resolves twice nor
 *  echoes a settled question back to every panel. */
export function answerPlanApproval(approved: boolean, feedback?: string): boolean {
  if (!active?.planApproval) return false;
  active.planApproval.resolve(approved, feedback);
  active.planApproval = undefined;
  return true;
}

/** The panel's answer to a parked elicitation. Returns whether it landed — a
 *  no-op when nothing is parked or the answer names an older request than the
 *  one now holding the slot. */
export function answerElicitation(
  requestId: string,
  action: "accept" | "decline",
  value?: Record<string, unknown>,
): boolean {
  if (!active?.elicitation || active.elicitation.requestId !== requestId) return false;
  active.elicitation.resolve({ action, ...(action === "accept" && value ? { value } : {}) });
  active.elicitation = undefined;
  return true;
}
