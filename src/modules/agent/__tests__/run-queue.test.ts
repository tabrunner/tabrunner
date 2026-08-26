import { describe, it, expect, beforeEach } from "vitest";
import { acquireRun, getActiveRun, releaseRun } from "../active-runs";
import type { ActiveRun, RunOwner } from "../active-runs";
import {
  cancelQueued,
  clearPendingQuestion,
  currentBoard,
  listQueue,
  markPendingQuestion,
  markRunningAwaiting,
  markRunningTab,
  restorePendingQuestion,
  runBoardItem,
  submitRun,
} from "../run-queue";

/** The mocked storage resolves in a microtask — let board writes land. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const launches: string[] = [];
const claims = new Map<string, ActiveRun>();

/** A launch closure that claims the slot, exactly as startAgentRun would. */
function launchFor(task: string, owner: RunOwner): () => void {
  return () => {
    launches.push(task);
    const claim = acquireRun(`c-${task}`, owner);
    if (claim.ok) claims.set(task, claim.run);
  };
}

function claim(task: string): ActiveRun {
  const run = claims.get(task);
  if (!run) throw new Error(`no claim for ${task}`);
  return run;
}

function submit(task: string, owner: RunOwner) {
  return submitRun({
    conversationId: `c-${task}`,
    owner,
    task,
    launch: launchFor(task, owner),
  });
}

beforeEach(async () => {
  // Drain the queue BEFORE freeing the slot, or the release pumps a leftover.
  for (const q of listQueue()) cancelQueued(q.id);
  const active = getActiveRun();
  if (active) releaseRun(active);
  launches.length = 0;
  claims.clear();
  await flush();
});

describe("submitRun", () => {
  it("starts immediately when the slot is free", async () => {
    const outcome = submit("a", "panel");
    expect(outcome).toEqual({ started: true });
    expect(launches).toEqual(["a"]);
    await flush();
    expect(currentBoard().running).toMatchObject({ task: "a", owner: "panel" });
  });

  it("queues FIFO when the slot is taken", () => {
    const hold = acquireRun("c-hold", "panel");
    if (!hold.ok) throw new Error("slot not free");

    expect(submit("a", "panel")).toMatchObject({ queued: 1 });
    expect(submit("b", "bridge")).toMatchObject({ queued: 2 });
    expect(submit("c", "panel")).toMatchObject({ queued: 3 });
    expect(launches).toEqual([]);
    expect(listQueue().map((q) => q.task)).toEqual(["a", "b", "c"]);
  });
});

describe("pump on release", () => {
  it("starts the next entry in order, keeping its owner", async () => {
    const hold = acquireRun("c-hold", "panel");
    if (!hold.ok) throw new Error("slot not free");
    submit("a", "bridge");
    submit("b", "panel");

    releaseRun(hold.run);
    expect(launches).toEqual(["a"]);
    expect(currentBoard().running).toMatchObject({ task: "a", owner: "bridge" });

    releaseRun(claim("a"));
    expect(launches).toEqual(["a", "b"]);
    expect(currentBoard().running).toMatchObject({ task: "b", owner: "panel" });

    releaseRun(claim("b"));
    await flush();
    expect(launches).toEqual(["a", "b"]);
    const board = await runBoardItem.get();
    expect(board.running).toBeUndefined();
    expect(board.queue).toEqual([]);
  });

  it("is a no-op when the queue is empty", async () => {
    const hold = acquireRun("c-hold", "panel");
    if (!hold.ok) throw new Error("slot not free");
    releaseRun(hold.run);
    await flush();
    expect(launches).toEqual([]);
    expect(await runBoardItem.get()).toEqual({ queue: [] });
  });
});

describe("cancelQueued", () => {
  it("removes a waiting entry and closes ranks", async () => {
    const hold = acquireRun("c-hold", "panel");
    if (!hold.ok) throw new Error("slot not free");
    submit("a", "panel");
    const b = submit("b", "panel");
    submit("c", "panel");
    if (!("queued" in b)) throw new Error("b did not queue");

    expect(cancelQueued(b.id)).toBe(true);
    expect(listQueue().map((q) => q.task)).toEqual(["a", "c"]);
    await flush();
    expect((await runBoardItem.get()).queue.map((q) => q.task)).toEqual(["a", "c"]);

    releaseRun(hold.run);
    releaseRun(claim("a"));
    expect(launches).toEqual(["a", "c"]);
    releaseRun(claim("c"));
  });

  it("returns false for an id that is not waiting", () => {
    expect(cancelQueued("nope")).toBe(false);
  });
});

describe("markRunningTab", () => {
  it("fills in the running entry's tab", async () => {
    submit("a", "panel");
    markRunningTab("c-a", 42);
    await flush();
    expect((await runBoardItem.get()).running).toMatchObject({ task: "a", tabId: 42 });
    releaseRun(claim("a"));
  });

  it("ignores a run that is no longer the board's running entry", () => {
    submit("a", "panel");
    markRunningTab("c-someone-else", 99);
    expect(currentBoard().running?.tabId).toBeUndefined();
    releaseRun(claim("a"));
  });
});

describe("deleteConversation", () => {
  it("cancels the deleted conversation's queued runs — a waiter must not resurrect it", async () => {
    const { deleteConversation } = await import("@/modules/conversation/conversations");
    const hold = acquireRun("c-hold", "panel");
    if (!hold.ok) throw new Error("slot not free");
    submit("a", "panel");
    submit("b", "panel");

    await deleteConversation("c-a");
    expect(listQueue().map((q) => q.task)).toEqual(["b"]);
    // The cancellation lands on the board too — no ghost entry for the UI.
    await flush();
    expect((await runBoardItem.get()).queue.map((q) => q.task)).toEqual(["b"]);

    releaseRun(hold.run);
    releaseRun(claim("b"));
  });
});

describe("markRunningAwaiting", () => {
  it("settles and re-raises the running entry's wait mark", async () => {
    submit("a", "panel");
    markRunningAwaiting("c-a", true);
    await flush();
    expect((await runBoardItem.get()).running).toMatchObject({ task: "a", awaiting: true });

    markRunningAwaiting("c-a", false);
    await flush();
    expect((await runBoardItem.get()).running).toMatchObject({ task: "a", awaiting: false });
    releaseRun(claim("a"));
  });

  it("parks the ask onto the board and takes it down with the answer", async () => {
    submit("a", "panel");
    const ask = { steps: ["Open the console", "Copy the key"], current: 0, reapproval: false };
    markRunningAwaiting("c-a", true, ask);
    await flush();
    // The card is answerable from the board alone — a panel that missed the
    // plan_approval broadcast still gets the question.
    expect((await runBoardItem.get()).running?.approval).toEqual(ask);

    markRunningAwaiting("c-a", false);
    await flush();
    const settled = (await runBoardItem.get()).running;
    expect(settled?.awaiting).toBe(false);
    expect(settled?.approval).toBeUndefined();
    releaseRun(claim("a"));
  });

  it("ignores a run that is no longer the board's running entry", () => {
    submit("a", "panel");
    markRunningAwaiting("c-someone-else", true);
    expect(currentBoard().running?.awaiting).toBeUndefined();
    releaseRun(claim("a"));
  });
});

describe("pendingQuestion", () => {
  it("outlives the run that asked it — the board keeps the answer owed", async () => {
    submit("a", "panel");
    markPendingQuestion("c-a", "add to cart?", ["yes", "no"]);
    // The slot frees but the question stays: the ambient signal must not
    // collapse into "idle" the moment the run lets go.
    releaseRun(claim("a"));
    await flush();
    const board = await runBoardItem.get();
    expect(board.running).toBeUndefined();
    expect(board.pendingQuestion).toEqual({
      conversationId: "c-a",
      question: "add to cart?",
      choices: ["yes", "no"],
    });
    clearPendingQuestion("c-a");
  });

  it("clears only its own conversation's question", async () => {
    markPendingQuestion("c-a", "add to cart?", ["yes"]);
    clearPendingQuestion("c-someone-else");
    expect(currentBoard().pendingQuestion).toMatchObject({ conversationId: "c-a" });
    clearPendingQuestion("c-a");
    await flush();
    expect((await runBoardItem.get()).pendingQuestion).toBeUndefined();
  });

  it("drops an empty choices list rather than persist a lie", () => {
    markPendingQuestion("c-a", "continue?", []);
    expect(currentBoard().pendingQuestion).toMatchObject({ conversationId: "c-a" });
    expect(currentBoard().pendingQuestion?.choices).toBeUndefined();
    clearPendingQuestion("c-a");
  });

  it("a worker restart keeps the parked question, not the dead run", async () => {
    markPendingQuestion("c-a", "add to cart?", ["yes", "no"]);
    await flush();
    const stored = (await runBoardItem.get()).pendingQuestion;
    // In-memory copy is gone with the old worker; storage carries it back.
    restorePendingQuestion(stored);
    expect(currentBoard().pendingQuestion).toEqual(stored);
    clearPendingQuestion("c-a");
  });
});
