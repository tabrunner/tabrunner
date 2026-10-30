import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireRun, listActiveRuns, releaseRun } from "../active-runs";
import type { ActiveRun, RunOwner } from "../active-runs";
import {
  cancelQueued,
  clearPendingQuestion,
  currentBoard,
  listQueue,
  markPendingQuestion,
  markRunningAwaiting,
  markRunningElicitation,
  markRunningRecording,
  markRunningTab,
  restorePendingQuestions,
  runBoardItem,
  submitRun,
  trackRunningRun,
} from "../run-queue";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const launches: string[] = [];
const claims = new Map<string, ActiveRun>();

function claim(id: string): ActiveRun {
  const run = claims.get(id);
  if (!run) throw new Error(`No claim for ${id}`);
  return run;
}

function submit(
  id: string,
  owner: RunOwner = "bridge",
  ownerId = id,
  conversationId = `chat-${id}`,
) {
  return submitRun({
    id,
    conversationId,
    owner,
    ownerId,
    task: id,
    launch: () => {
      const result = acquireRun(conversationId, owner, ownerId, id);
      if (!result.ok) throw new Error(`Rejected queued launch: ${id}`);
      launches.push(id);
      claims.set(id, result.run);
    },
  });
}

async function clean(): Promise<void> {
  for (const entry of listQueue()) cancelQueued(entry.id);
  for (const run of listActiveRuns()) releaseRun(run);
  for (const question of currentBoard().pendingQuestions)
    clearPendingQuestion(question.conversationId);
  await flush();
}

beforeEach(async () => {
  await clean();
  launches.length = 0;
  claims.clear();
});
afterEach(clean);

describe("run queue admission", () => {
  it("starts unrelated owners concurrently and keeps their submission IDs", async () => {
    expect(submit("a")).toEqual({ started: true, id: "a" });
    expect(submit("b")).toEqual({ started: true, id: "b" });
    expect(submit("panel", "panel", "panel")).toEqual({ started: true, id: "panel" });
    expect(launches).toEqual(["a", "b", "panel"]);
    await flush();
    expect((await runBoardItem.get()).running).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "a", ownerId: "a", conversationId: "chat-a" }),
        expect.objectContaining({ id: "b", ownerId: "b", conversationId: "chat-b" }),
      ]),
    );
  });

  it("queues after the fourth admitted owner and starts when capacity frees", () => {
    for (const id of ["a", "b", "c", "d"]) submit(id);
    expect(submit("e")).toEqual({ queued: 1, id: "e" });
    expect(submit("f")).toEqual({ queued: 2, id: "f" });
    expect(launches).toEqual(["a", "b", "c", "d"]);
    releaseRun(claim("b"));
    expect(launches).toEqual(["a", "b", "c", "d", "e"]);
    expect(listQueue().map((entry) => entry.id)).toEqual(["f"]);
  });

  it("keeps one client's submissions FIFO while another client passes", () => {
    submit("a1", "bridge", "a");
    expect(submit("a2", "bridge", "a")).toMatchObject({ queued: 1 });
    expect(submit("a3", "bridge", "a")).toMatchObject({ queued: 2 });
    expect(submit("b1", "bridge", "b")).toMatchObject({ started: true });
    expect(launches).toEqual(["a1", "b1"]);
    releaseRun(claim("a1"));
    expect(launches).toEqual(["a1", "b1", "a2"]);
    releaseRun(claim("a2"));
    expect(launches).toEqual(["a1", "b1", "a2", "a3"]);
  });

  it("serializes the conversation even across different clients", () => {
    submit("a", "bridge", "a", "shared-chat");
    expect(submit("b", "bridge", "b", "shared-chat")).toMatchObject({ queued: 1 });
    expect(submit("c", "bridge", "c")).toMatchObject({ started: true });
    releaseRun(claim("a"));
    expect(launches).toEqual(["a", "c", "b"]);
  });

  it("a blocked queue lane does not block an unrelated waiter on release", () => {
    submit("a1", "bridge", "a");
    submit("b");
    submit("c");
    submit("d");
    submit("a2", "bridge", "a");
    submit("e");
    releaseRun(claim("b"));
    expect(launches).toEqual(["a1", "b", "c", "d", "e"]);
    expect(listQueue().map((entry) => entry.id)).toEqual(["a2"]);
  });

  it("a blocked conversation also fences later work from that queued owner", () => {
    submit("hold", "bridge", "holder", "shared-chat");
    submit("first", "bridge", "a", "shared-chat");
    expect(submit("second", "bridge", "a", "other-chat")).toMatchObject({ queued: 2 });
    expect(submit("b")).toMatchObject({ started: true });
    releaseRun(claim("hold"));
    expect(launches).toEqual(["hold", "b", "first"]);
    releaseRun(claim("first"));
    expect(launches).toEqual(["hold", "b", "first", "second"]);
  });

  it("does not advance an aborted owner until final cleanup releases it", () => {
    submit("first", "bridge", "a");
    submit("next", "bridge", "a");
    claim("first").controller.abort();
    expect(launches).toEqual(["first"]);
    releaseRun(claim("first"));
    expect(launches).toEqual(["first", "next"]);
  });
});

describe("queued cancellation", () => {
  it("removes only the exact waiting ID and keeps sibling tasks ordered", async () => {
    submit("a1", "bridge", "a");
    submit("a2", "bridge", "a");
    submit("a3", "bridge", "a");
    expect(cancelQueued("a2")).toBe(true);
    expect(cancelQueued("a1")).toBe(false);
    expect(cancelQueued("missing")).toBe(false);
    expect(listQueue().map((entry) => entry.id)).toEqual(["a3"]);
    await flush();
    expect((await runBoardItem.get()).queue).toEqual([
      expect.objectContaining({ id: "a3", ownerId: "a" }),
    ]);
    releaseRun(claim("a1"));
    expect(launches).toEqual(["a1", "a3"]);
  });

  it("cancels only the deleted conversation's queued tasks", async () => {
    const { deleteConversation } = await import("@/modules/conversation/conversations");
    submit("hold", "panel", "panel");
    submit("a", "panel", "panel", "delete-me");
    submit("b", "panel", "panel", "keep-me");
    await deleteConversation("delete-me");
    expect(listQueue().map((entry) => entry.id)).toEqual(["b"]);
    await flush();
    expect((await runBoardItem.get()).queue.map((entry) => entry.id)).toEqual(["b"]);
    releaseRun(claim("hold"));
    expect(launches).toEqual(["hold", "b"]);
  });
});

describe("run board targeting", () => {
  it("marks only the named live run and ignores stale run IDs", async () => {
    submit("a");
    submit("b");
    markRunningTab("a", 42, 3);
    markRunningRecording("a", true);
    markRunningTab("stale", 99, 7);
    markRunningAwaiting("stale", true);
    markRunningElicitation("stale", { requestId: "old", message: "Old ask", serverName: "acme" });
    await flush();
    const board = await runBoardItem.get();
    expect(board.running.find((run) => run.id === "a")).toMatchObject({
      tabId: 42,
      windowId: 3,
      recording: true,
    });
    expect(board.running.find((run) => run.id === "b")).not.toHaveProperty("tabId");
    releaseRun(claim("a"));
    markRunningTab("a", 100);
    expect(currentBoard().running).toEqual([expect.objectContaining({ id: "b" })]);
  });

  it("parks and settles an approval without changing another run", async () => {
    submit("a");
    submit("b");
    const ask = { steps: ["Send"], current: 0, reapproval: false };
    markRunningAwaiting("a", true, ask);
    await flush();
    expect((await runBoardItem.get()).running.find((run) => run.id === "a")).toMatchObject({
      awaiting: true,
      approval: ask,
    });
    expect(currentBoard().running.find((run) => run.id === "b")?.awaiting).toBeUndefined();
    markRunningAwaiting("a", false);
    await flush();
    const settled = (await runBoardItem.get()).running.find((run) => run.id === "a");
    expect(settled?.awaiting).toBe(false);
    expect(settled?.approval).toBeUndefined();
  });

  it("keeps one parked ask per run and leaves other runs' asks intact", async () => {
    submit("a");
    submit("b");
    const gate = { steps: ["Open the console"], current: 0, reapproval: false };
    const server = { requestId: "request", message: "Allow access?", serverName: "acme" };
    markRunningAwaiting("a", true, gate);
    markRunningAwaiting("b", true, gate);
    markRunningElicitation("a", server);
    let a = currentBoard().running.find((run) => run.id === "a");
    expect(a?.elicitation).toEqual(server);
    expect(a?.approval).toBeUndefined();
    expect(currentBoard().running.find((run) => run.id === "b")?.approval).toEqual(gate);
    markRunningAwaiting("a", true, gate);
    a = currentBoard().running.find((run) => run.id === "a");
    expect(a?.approval).toEqual(gate);
    expect(a?.elicitation).toBeUndefined();
    markRunningElicitation("a");
    expect(currentBoard().running.find((run) => run.id === "a")?.awaiting).toBe(false);
    await flush();
  });

  it("writes each run's last transition in order", async () => {
    submit("a");
    submit("b");
    markRunningAwaiting("a", true, { steps: ["Send"], current: 0, reapproval: false });
    markRunningTab("a", 7, 3);
    markRunningElicitation("a", { requestId: "r1", message: "Continue?", serverName: "acme" });
    markRunningAwaiting("a", false);
    markRunningTab("a", 9, 3);
    markRunningTab("b", 10, 4);
    await flush();
    const board = await runBoardItem.get();
    expect(board.running.find((run) => run.id === "a")).toMatchObject({
      tabId: 9,
      windowId: 3,
      awaiting: false,
    });
    expect(board.running.find((run) => run.id === "a")?.elicitation).toBeUndefined();
    expect(board.running.find((run) => run.id === "b")).toMatchObject({ tabId: 10, windowId: 4 });
  });

  it("registers direct sessions on the same board until release", async () => {
    const acquired = acquireRun("direct-chat", "bridge", "client", "direct-id");
    if (!acquired.ok) throw new Error("Direct claim rejected");
    trackRunningRun(acquired.run, "Read the invoice");
    markRunningTab(acquired.run.id, 7, 1);
    expect(currentBoard().running).toEqual([
      expect.objectContaining({ id: "direct-id", task: "Read the invoice", tabId: 7 }),
    ]);
    releaseRun(acquired.run);
    await flush();
    expect(await runBoardItem.get()).toEqual({ running: [], queue: [], pendingQuestions: [] });
  });
});

describe("conversation questions", () => {
  it("keeps questions after their runs end and clears only the named conversation", async () => {
    submit("a");
    submit("b");
    markPendingQuestion("chat-a", "Send invoice?", ["yes", "no"]);
    markPendingQuestion("chat-b", "Choose an account");
    releaseRun(claim("a"));
    releaseRun(claim("b"));
    await flush();
    expect((await runBoardItem.get()).running).toEqual([]);
    expect(currentBoard().pendingQuestions).toHaveLength(2);
    clearPendingQuestion("chat-a");
    clearPendingQuestion("other-chat");
    expect(currentBoard().pendingQuestions).toEqual([
      { conversationId: "chat-b", question: "Choose an account" },
    ]);
  });

  it("keeps each ended run's own tab and window on its pending question", async () => {
    submit("a");
    submit("b");
    markRunningTab("a", 11, 1);
    markRunningTab("b", 22, 2);
    markPendingQuestion("chat-a", "Send invoice?");
    markPendingQuestion("chat-b", "Choose an account");
    releaseRun(claim("a"));
    releaseRun(claim("b"));
    await flush();
    const pending = (await runBoardItem.get()).pendingQuestions;
    expect(pending).toEqual([
      { conversationId: "chat-a", question: "Send invoice?", tabId: 11, windowId: 1 },
      { conversationId: "chat-b", question: "Choose an account", tabId: 22, windowId: 2 },
    ]);
    clearPendingQuestion("chat-a");
    expect(currentBoard().pendingQuestions).toEqual([pending[1]]);
  });

  it("omits empty choices and restores all owed questions after worker restart", async () => {
    markPendingQuestion("chat-a", "Continue?", []);
    expect(currentBoard().pendingQuestions[0]?.choices).toBeUndefined();
    restorePendingQuestions([
      { conversationId: "chat-b", question: "Send it?", choices: ["yes", "no"] },
    ]);
    expect(currentBoard().pendingQuestions).toEqual([
      { conversationId: "chat-a", question: "Continue?" },
      { conversationId: "chat-b", question: "Send it?", choices: ["yes", "no"] },
    ]);
    await flush();
    expect((await runBoardItem.get()).pendingQuestions).toHaveLength(2);
  });
});
