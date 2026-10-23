import { describe, it, expect } from "vitest";

import { applyQuestion, applyStatusEvent, emptyStatus, newRunStatus } from "../status";

describe("bridge status", () => {
  it("accumulates the run the daemon serves to getStatus", () => {
    const status = newRunStatus("conv-1", "run-1");

    expect(applyStatusEvent(status, { type: "token", text: "hi" })).toBeNull(); // never forwarded
    applyStatusEvent(status, { type: "driving", tabId: 7, windowId: 1, title: "Inbox" });
    applyStatusEvent(status, { type: "step", tool: "click", summary: "Clicked Send", ok: true });
    applyStatusEvent(status, { type: "plan", steps: ["find", "send"], current: 1 });
    applyStatusEvent(status, { type: "done", summary: "Sent." });

    expect(status).toMatchObject({
      state: "done",
      summary: "Sent.",
      driving: { tabId: 7, title: "Inbox" },
      steps: [{ tool: "click", summary: "Clicked Send", ok: true }],
      plan: { steps: ["find", "send"], current: 1 },
    });
  });

  it("keeps the question as the closing state — ask_user ends the run with a done too", () => {
    const status = newRunStatus("conv-1", "run-1");
    applyQuestion(status, "Pay the $42 invoice?");
    applyStatusEvent(status, { type: "done", summary: "Waiting on you." });

    expect(status.state).toBe("question");
    expect(status.question).toBe("Pay the $42 invoice?");
  });

  it("an error is terminal and carries what failed", () => {
    const status = newRunStatus("conv-1", "run-1");
    applyStatusEvent(status, { type: "error", message: "No active provider" });

    expect(status).toMatchObject({ state: "error", error: "No active provider" });
    expect(status.finishedAt).not.toBeNull();
  });

  it("starts idle with nothing to report", () => {
    expect(emptyStatus()).toMatchObject({ state: "idle", runId: null, steps: [], question: null });
  });
  it("keeps one client's steps and questions out of another client's status", () => {
    const first = newRunStatus("conv-a", "run-a");
    const second = newRunStatus("conv-b", "run-b");
    applyStatusEvent(first, { type: "step", tool: "click", summary: "Clicked Send" });
    applyQuestion(second, "Send the invoice?");

    expect(first.state).toBe("running");
    expect(first.question).toBeNull();
    expect(second.steps).toEqual([]);
    expect(second.state).toBe("question");
  });
});
