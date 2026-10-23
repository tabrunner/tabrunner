import { createLogger } from "@/lib/logger";
import type { PlanApprovalPayload } from "@/shared/protocol";

const log = createLogger("runs");

export type RunOwner = "panel" | "bridge" | "schedule";

/** Browser work is bounded separately from each provider's stream gate. */
export const MAX_ACTIVE_RUNS = 4;

/** Each live task keeps its controls until its final cleanup has finished. */
export interface ActiveRun {
  id: string;
  conversationId: string;
  owner: RunOwner;
  ownerId: string;
  controller: AbortController;
  readsClosed: boolean;
  pendingReads: Set<Promise<unknown>>;
  /** Messages typed mid-run, drained by the loop at each tool boundary. */
  injectedQueue: { id: string; text: string }[];
  /** Spend accumulates; contextTokens is the latest turn's input size. */
  usage: { input: number; output: number; contextTokens: number; cost?: number };
  planApproval?: {
    ask: PlanApprovalPayload;
    resolve: (approved: boolean, feedback?: string) => void;
  };
  elicitation?: {
    requestId: string;
    resolve: (result: { action: "accept" | "decline"; value?: Record<string, unknown> }) => void;
  };
}

const active = new Map<string, ActiveRun>();
const releaseListeners = new Set<(run: ActiveRun) => void>();

export function onRunReleased(cb: (run: ActiveRun) => void): () => void {
  releaseListeners.add(cb);
  return () => releaseListeners.delete(cb);
}

export function listActiveRuns(): ActiveRun[] {
  return [...active.values()];
}

export function getRunById(id: string): ActiveRun | null {
  return active.get(id) ?? null;
}

export function getActiveRun(conversationId: string): ActiveRun | null {
  return listActiveRuns().find((run) => run.conversationId === conversationId) ?? null;
}

export function getOwnerRun(owner: RunOwner, ownerId: string): ActiveRun | null {
  return listActiveRuns().find((run) => run.owner === owner && run.ownerId === ownerId) ?? null;
}

function conflict(conversationId: string, owner: RunOwner, ownerId: string): ActiveRun | null {
  return (
    getActiveRun(conversationId) ??
    getOwnerRun(owner, ownerId) ??
    (active.size >= MAX_ACTIVE_RUNS ? (active.values().next().value ?? null) : null)
  );
}

export function canStartRun(conversationId: string, owner: RunOwner, ownerId: string): boolean {
  return conflict(conversationId, owner, ownerId) === null;
}

export type AcquireResult = { ok: true; run: ActiveRun } | { ok: false; active: ActiveRun };

/** Admission is synchronous: no other task can acquire between the check and claim. */
export function acquireRun(
  conversationId: string,
  owner: RunOwner,
  ownerId: string,
  id: string = crypto.randomUUID(),
): AcquireResult {
  const holder = active.get(id) ?? conflict(conversationId, owner, ownerId);
  if (holder) return { ok: false, active: holder };
  const run: ActiveRun = {
    id,
    conversationId,
    owner,
    ownerId,
    controller: new AbortController(),
    readsClosed: false,
    pendingReads: new Set(),
    injectedQueue: [],
    usage: { input: 0, output: 0, contextTokens: 0 },
  };
  active.set(id, run);
  log.debug("run acquired", { conversationId, owner });
  return { ok: true, run };
}

/** Call only after draining work and releasing this run's browser resources. */
export function releaseRun(run: ActiveRun): void {
  if (active.get(run.id) !== run) return;
  active.delete(run.id);
  for (const cb of releaseListeners) cb(run);
}

export function answerPlanApproval(runId: string, approved: boolean, feedback?: string): boolean {
  const run = active.get(runId);
  if (run?.owner !== "panel" || run.controller.signal.aborted || !run.planApproval) return false;
  const approval = run.planApproval;
  run.planApproval = undefined;
  approval.resolve(approved, feedback);
  return true;
}

export function answerElicitation(
  runId: string,
  requestId: string,
  action: "accept" | "decline",
  value?: Record<string, unknown>,
): boolean {
  const run = active.get(runId);
  if (
    run?.owner !== "panel" ||
    run.controller.signal.aborted ||
    run.elicitation?.requestId !== requestId
  ) {
    return false;
  }
  const elicitation = run.elicitation;
  run.elicitation = undefined;
  elicitation.resolve({ action, ...(action === "accept" && value ? { value } : {}) });
  return true;
}
