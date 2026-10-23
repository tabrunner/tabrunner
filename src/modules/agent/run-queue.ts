import { createWriteQueue, defineItem } from "@/lib/storage";
import { createLogger, truncate } from "@/lib/logger";
import type { ElicitationAsk, PlanApprovalPayload } from "@/shared/protocol";
import { canStartRun, onRunReleased } from "./active-runs";
import type { ActiveRun, RunOwner } from "./active-runs";

const log = createLogger("runs");

export interface QueuedRun {
  id: string;
  conversationId: string;
  owner: RunOwner;
  ownerId: string;
  task: string;
  enqueuedAt: number;
}

interface QueueEntry extends QueuedRun {
  /** Claims synchronously before the launch's first await. */
  launch: () => void;
}

export interface RunningRun {
  id: string;
  conversationId: string;
  task: string;
  owner: RunOwner;
  ownerId: string;
  startedAt: number;
  tabId?: number;
  windowId?: number;
  awaiting?: boolean;
  approval?: PlanApprovalPayload;
  elicitation?: ElicitationAsk;
  recording?: boolean;
}

export interface PendingQuestion {
  tabId?: number;
  windowId?: number;
  conversationId: string;
  question: string;
  choices?: string[];
}

export interface RunBoard {
  running: RunningRun[];
  pendingQuestions: PendingQuestion[];
  queue: QueuedRun[];
}

// Live state is disposable. A new schema must not read a previous worker's slot shape.
export const runBoardItem = defineItem<RunBoard>("run-board-v2", {
  running: [],
  pendingQuestions: [],
  queue: [],
});

const queue: QueueEntry[] = [];
const running = new Map<string, RunningRun>();
const pendingQuestions = new Map<string, PendingQuestion>();

export type SubmitOutcome = { started: true; id: string } | { queued: number; id: string };

function sharesLane(a: QueueEntry, b: QueueEntry): boolean {
  return a.conversationId === b.conversationId || (a.owner === b.owner && a.ownerId === b.ownerId);
}

function launch(entry: QueueEntry): void {
  running.set(entry.id, {
    id: entry.id,
    conversationId: entry.conversationId,
    owner: entry.owner,
    ownerId: entry.ownerId,
    task: entry.task,
    startedAt: Date.now(),
  });
  entry.launch();
}

/** FIFO within a client/conversation; unrelated work can pass a blocked lane. */
export function submitRun(entry: Omit<QueueEntry, "enqueuedAt">): SubmitOutcome {
  const queued: QueueEntry = { ...entry, enqueuedAt: Date.now() };
  if (
    !queue.some((earlier) => sharesLane(earlier, queued)) &&
    canStartRun(entry.conversationId, entry.owner, entry.ownerId)
  ) {
    launch(queued);
    void writeBoard();
    return { started: true, id: entry.id };
  }
  queue.push(queued);
  log.info("run queued", { owner: entry.owner, task: truncate(entry.task, 120) });
  void writeBoard();
  return { queued: queue.length, id: queued.id };
}

/** Direct sessions use the same board and lifetime, without a queued launch. */
export function trackRunningRun(run: ActiveRun, task: string): void {
  running.set(run.id, {
    id: run.id,
    conversationId: run.conversationId,
    owner: run.owner,
    ownerId: run.ownerId,
    task,
    startedAt: Date.now(),
  });
  void writeBoard();
}

export function cancelQueued(id: string): boolean {
  const i = queue.findIndex((entry) => entry.id === id);
  if (i < 0) return false;
  queue.splice(i, 1);
  pumpQueue();
  void writeBoard();
  return true;
}

export function listQueue(): QueuedRun[] {
  return queue.map(({ launch: _launch, ...entry }) => entry);
}

export function currentBoard(): RunBoard {
  return {
    running: [...running.values()],
    pendingQuestions: [...pendingQuestions.values()],
    queue: listQueue(),
  };
}

function updateRunning(id: string, update: Partial<RunningRun>): void {
  const entry = running.get(id);
  if (!entry) return;
  running.set(id, { ...entry, ...update });
  void writeBoard();
}

export function markRunningTab(id: string, tabId: number, windowId?: number): void {
  updateRunning(id, { tabId, windowId });
}

export function markRunningAwaiting(
  id: string,
  awaiting: boolean,
  approval?: PlanApprovalPayload,
): void {
  updateRunning(id, {
    awaiting,
    approval: awaiting ? approval : undefined,
    elicitation: undefined,
  });
}

export function markRunningElicitation(id: string, ask?: ElicitationAsk): void {
  updateRunning(id, { awaiting: ask !== undefined, elicitation: ask, approval: undefined });
}

export function markRunningRecording(id: string, recording: boolean): void {
  updateRunning(id, { recording });
}

/** Questions outlive their run but belong only to the conversation that asked. */
export function markPendingQuestion(
  conversationId: string,
  question: string,
  choices?: string[],
): void {
  const task = [...running.values()].find((run) => run.conversationId === conversationId);
  pendingQuestions.set(conversationId, {
    ...(task?.tabId !== undefined ? { tabId: task.tabId, windowId: task.windowId } : {}),
    conversationId,
    question,
    ...(choices?.length ? { choices } : {}),
  });
  void writeBoard();
}

export function clearPendingQuestion(conversationId: string): void {
  if (!pendingQuestions.delete(conversationId)) return;
  void writeBoard();
}

export function restorePendingQuestions(stored: PendingQuestion[]): void {
  for (const question of stored) pendingQuestions.set(question.conversationId, question);
}

const boardListeners = new Set<(board: RunBoard) => void>();

export function onBoardChanged(cb: (board: RunBoard) => void): () => void {
  boardListeners.add(cb);
  return () => boardListeners.delete(cb);
}

const enqueueWrite = createWriteQueue();
function writeBoard(): Promise<void> {
  return enqueueWrite(async () => {
    const board = currentBoard();
    for (const cb of boardListeners) cb(board);
    await runBoardItem.set(board);
  }).catch((e) => log.warn("board write failed:", e instanceof Error ? e.message : String(e)));
}

function pumpQueue(): void {
  const blockedConversations = new Set<string>();
  const blockedOwners = new Set<string>();
  for (let i = 0; i < queue.length;) {
    const entry = queue[i];
    if (!entry) break;
    const ownerKey = `${entry.owner}:${entry.ownerId}`;
    if (
      blockedConversations.has(entry.conversationId) ||
      blockedOwners.has(ownerKey) ||
      !canStartRun(entry.conversationId, entry.owner, entry.ownerId)
    ) {
      blockedConversations.add(entry.conversationId);
      blockedOwners.add(ownerKey);
      i++;
      continue;
    }
    queue.splice(i, 1);
    launch(entry);
  }
}

onRunReleased((run) => {
  running.delete(run.id);
  pumpQueue();
  void writeBoard();
});
