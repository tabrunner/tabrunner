import { defineItem } from "@/lib/storage";
import { createLogger, truncate } from "@/lib/logger";
import type { ElicitationAsk, PlanApprovalPayload } from "@/shared/protocol";
import { getActiveRun, onRunReleased } from "./active-runs";
import type { RunOwner } from "./active-runs";

const log = createLogger("runs");

/**
 * The serial run queue on top of the single run slot. One run drives at a time
 * (one CDP target, one browser), everything else waits FIFO. Callers hand in a
 * `launch` closure — the exact call they would have made for an immediate start
 * — so a queued run is indistinguishable from an immediate one once it starts,
 * and ownership (who may stop or steer it) never changes hands.
 *
 * Every transition is mirrored to `runBoardItem`, the ambient "what is TabRunner
 * doing" record: the floating widget, the panel's run board, and the toolbar
 * badge read it over storage watch, the MCP bridge forwards it as compact
 * events — no new port plumbing anywhere.
 */

/** One queued submission, as the UI and the bridge protocol see it. */
export interface QueuedRun {
  id: string;
  conversationId: string;
  owner: RunOwner;
  task: string;
  enqueuedAt: number;
}

interface QueueEntry extends QueuedRun {
  /** Starts the run exactly as its owner's immediate path would. */
  launch: () => void;
}

/** The ambient run state every surface reads. */
export interface RunBoard {
  running?: {
    conversationId: string;
    task: string;
    owner: RunOwner;
    /** When the run claimed the slot — a panel that reopened mid-run reads its
     *  elapsed clock from here, its own run-state having died with the close. */
    startedAt: number;
    tabId?: number;
    /** Parked on the user's answer (plan approval) — alive, but not working. */
    awaiting?: boolean;
    /**
     * The parked ask itself — the approval card, storage-backed. The port
     * broadcast arms the panels that heard it; this arms every other one: a
     * panel that was opened, switched, or left deaf after the park reads the
     * same board every surface reads, so the question is on screen with a way
     * to say yes even when no plan_approval event ever reached it. Cleared the
     * moment the gate is answered, approve or reject.
     */
    approval?: PlanApprovalPayload;
    /**
     * The plan gate's twin: a remote MCP server's question, parked mid-tool-call.
     * Same storage-backed delivery, same answer-takes-it-down lifecycle — and it
     * needed it more, since the elicitation broadcast never had any reconnect
     * path at all. The loop parks on one thing at a time, so at most one of
     * `approval` / `elicitation` is set.
     */
    elicitation?: ElicitationAsk;
    /** The run is documenting itself: screens of the driven tab are being kept.
     *  Ambient, because the surfaces that must say so (toolbar title, driven-tab
     *  badge) outlive the panel that would otherwise be the only witness. */
    recording?: boolean;
  };
  /**
   * An ask_user question the run ended on — the slot is free, but the answer is
   * still owed. Unlike `running.awaiting` (a live parked run), there is no run
   * to mark; this keeps the ambient "answer needed" signal up until the next run
   * (the answer) clears it. At most one at a time — one run drives at a time.
   */
  pendingQuestion?: {
    conversationId: string;
    question: string;
    choices?: string[];
  };
  queue: QueuedRun[];
}

export const runBoardItem = defineItem<RunBoard>("run-board", { queue: [] });

const queue: QueueEntry[] = [];
/** The board's view of the active run — set at submit, tab id filled in later. */
let running: RunBoard["running"] | null = null;
/** The board's view of a question awaiting an answer — outlives the run that asked it. */
let pendingQuestion: RunBoard["pendingQuestion"];

export type SubmitOutcome = { started: true } | { queued: number; id: string };

/**
 * Free slot → start now; occupied → wait FIFO. The check and the launch's slot
 * claim are one synchronous turn (launch's first await comes after acquireRun),
 * so the slot can't be taken in between.
 */
export function submitRun(entry: Omit<QueueEntry, "id" | "enqueuedAt">): SubmitOutcome {
  if (!getActiveRun()) {
    running = {
      conversationId: entry.conversationId,
      task: entry.task,
      owner: entry.owner,
      startedAt: Date.now(),
    };
    entry.launch();
    void writeBoard();
    return { started: true };
  }
  const queued: QueueEntry = { ...entry, id: crypto.randomUUID(), enqueuedAt: Date.now() };
  queue.push(queued);
  log.info("run queued", {
    position: queue.length,
    owner: entry.owner,
    task: truncate(entry.task, 120),
  });
  void writeBoard();
  return { queued: queue.length, id: queued.id };
}

/** Take a waiting entry out of the line. False when it already left (started). */
export function cancelQueued(id: string): boolean {
  const i = queue.findIndex((q) => q.id === id);
  if (i < 0) return false;
  queue.splice(i, 1);
  void writeBoard();
  return true;
}

export function listQueue(): QueuedRun[] {
  return queue.map((q) => ({
    id: q.id,
    conversationId: q.conversationId,
    owner: q.owner,
    task: q.task,
    enqueuedAt: q.enqueuedAt,
  }));
}

/** The board as it stands — same shape the storage item carries. */
export function currentBoard(): RunBoard {
  return {
    ...(running ? { running } : {}),
    ...(pendingQuestion ? { pendingQuestion } : {}),
    queue: listQueue(),
  };
}

/**
 * The running entry's tab — filled in once the run has resolved its target,
 * and again whenever switch_tab re-targets it. No-op for a run that is no
 * longer the board's running entry (a stale unwind must not move the board).
 */
export function markRunningTab(conversationId: string, tabId: number): void {
  if (!running || running.conversationId !== conversationId) return;
  running = { ...running, tabId };
  void writeBoard();
}

/**
 * The running entry parked on the user's answer (plan approval) or got it.
 * Same stale-guard as markRunningTab — a run that already ended must not move
 * the board. Parking carries the ask, so the card is answerable from the board
 * alone; answering takes it back down, whichever way the gate went.
 */
export function markRunningAwaiting(
  conversationId: string,
  awaiting: boolean,
  approval?: PlanApprovalPayload,
): void {
  if (!running || running.conversationId !== conversationId) return;
  running = awaiting
    ? { ...running, awaiting, ...(approval ? { approval } : {}) }
    : { ...running, awaiting, approval: undefined };
  void writeBoard();
}

/**
 * A parked elicitation — a remote MCP server's question — or its answer. The
 * ask rides the board like the plan gate's, so a panel that missed the
 * elicitation broadcast still gets the question; the flag drops with it, since
 * the loop can be parked on only one thing at a time. Same stale-guard as its
 * siblings.
 */
export function markRunningElicitation(conversationId: string, ask?: ElicitationAsk): void {
  if (!running || running.conversationId !== conversationId) return;
  running = { ...running, awaiting: ask !== undefined, elicitation: ask };
  void writeBoard();
}

/**
 * The running entry started documenting itself. Same stale-guard as its
 * siblings; arming happens mid-run, so this is never known at submit.
 */
export function markRunningRecording(conversationId: string, recording: boolean): void {
  if (!running || running.conversationId !== conversationId) return;
  running = { ...running, recording };
  void writeBoard();
}

/**
 * A run ended on ask_user — record the question as an ambient fact, since the
 * slot frees immediately and the widget/badge/panel would otherwise go silent
 * while the user is still owed an answer. A queue entry's question never
 * replaces the running run's: only one run can ask, and it is the one ending.
 */
export function markPendingQuestion(
  conversationId: string,
  question: string,
  choices?: string[],
): void {
  pendingQuestion = {
    conversationId,
    question,
    ...(choices?.length ? { choices } : {}),
  };
  void writeBoard();
}

/** The answer (the next run) retires the question. No-op for a different thread. */
export function clearPendingQuestion(conversationId: string): void {
  if (pendingQuestion?.conversationId !== conversationId) return;
  pendingQuestion = undefined;
  void writeBoard();
}

/**
 * Worker restart: the slot and the queue died with the old worker, but a parked
 * question is still owed an answer. The storage item carries it, the in-memory
 * copy does not — bring it back so `currentBoard()` (the widget, the badge)
 * keeps agreeing with what the panel already sees. No write: storage is right.
 */
export function restorePendingQuestion(stored: RunBoard["pendingQuestion"]): void {
  pendingQuestion = stored;
}

/** In-worker board subscription — the bridge mirrors it into its compact stream. */
export function onBoardChanged(cb: (board: RunBoard) => void): () => void {
  boardListeners.add(cb);
  return () => boardListeners.delete(cb);
}

const boardListeners = new Set<(board: RunBoard) => void>();

async function writeBoard(): Promise<void> {
  const board = currentBoard();
  for (const cb of boardListeners) cb(board);
  await runBoardItem.set(board);
}

// A freed slot starts the next waiter — every end path (done, error, stop,
// driven-tab close) funnels through releaseRun, so they all pump. Launch first,
// board second: the launch rewrites the bridge's status mirror, and the board
// write then lands the queue on top of it.
onRunReleased(() => {
  const next = queue.shift();
  if (!next) {
    running = null;
    void writeBoard();
    return;
  }
  running = {
    conversationId: next.conversationId,
    task: next.task,
    owner: next.owner,
    startedAt: Date.now(),
  };
  log.info("queued run starting", {
    owner: next.owner,
    task: truncate(next.task, 120),
  });
  next.launch();
  void writeBoard();
});
