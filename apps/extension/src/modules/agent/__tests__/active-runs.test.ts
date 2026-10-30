import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireRun,
  answerElicitation,
  answerPlanApproval,
  canStartRun,
  getActiveRun,
  getOwnerRun,
  getRunById,
  listActiveRuns,
  MAX_ACTIVE_RUNS,
  releaseRun,
} from "../active-runs";
import type { RunOwner } from "../active-runs";

function claim(conversationId: string, owner: RunOwner, ownerId: string, id?: string) {
  const result = acquireRun(conversationId, owner, ownerId, id);
  if (!result.ok) throw new Error(`Run rejected: ${conversationId}`);
  return result.run;
}

afterEach(() => {
  for (const run of listActiveRuns()) releaseRun(run);
});

describe("run admission", () => {
  it("allows distinct owners to overlap up to the four-run limit", () => {
    const panel = claim("panel-chat", "panel", "panel");
    const first = claim("first-chat", "bridge", "first-client");
    claim("second-chat", "bridge", "second-client");
    claim("schedule-chat", "schedule", "schedule-id");

    expect(listActiveRuns()).toHaveLength(MAX_ACTIVE_RUNS);
    expect(MAX_ACTIVE_RUNS).toBe(4);
    expect(getActiveRun("first-chat")).toBe(first);
    expect(getOwnerRun("panel", "panel")).toBe(panel);
    expect(getRunById(first.id)).toBe(first);
    expect(canStartRun("fifth-chat", "bridge", "third-client")).toBe(false);
    expect(acquireRun("fifth-chat", "bridge", "third-client").ok).toBe(false);
    releaseRun(panel);
    expect(canStartRun("fifth-chat", "bridge", "third-client")).toBe(true);
  });

  it("serializes the same owner or the same conversation, not the owner category", () => {
    const first = claim("shared-chat", "bridge", "client-a");
    expect(acquireRun("other-chat", "bridge", "client-a")).toEqual({ ok: false, active: first });
    expect(acquireRun("shared-chat", "bridge", "client-b")).toEqual({ ok: false, active: first });
    expect(acquireRun("other-chat", "bridge", "client-b").ok).toBe(true);
    expect(canStartRun("third-chat", "schedule", "client-a")).toBe(true);
  });

  it("keeps an aborted run admitted until its cleanup releases it", () => {
    const run = claim("chat", "bridge", "client");
    run.controller.abort();
    expect(getRunById(run.id)).toBe(run);
    expect(canStartRun("next-chat", "bridge", "client")).toBe(false);
    releaseRun(run);
    expect(canStartRun("next-chat", "bridge", "client")).toBe(true);
  });

  it("does not let a stale handle release the run that reused its ID", () => {
    const stale = claim("old-chat", "bridge", "client", "stable-id");
    releaseRun(stale);
    const current = claim("next-chat", "bridge", "client", "stable-id");
    releaseRun(stale);
    expect(getRunById("stable-id")).toBe(current);
    expect(acquireRun("third-chat", "bridge", "other-client", "stable-id")).toEqual({
      ok: false,
      active: current,
    });
  });

  it("starts external read admission open with a separate drain set for each run", () => {
    const a = claim("a-chat", "bridge", "a");
    const b = claim("b-chat", "bridge", "b");
    a.pendingReads.add(Promise.resolve());
    a.readsClosed = true;
    expect(b.pendingReads.size).toBe(0);
    expect(b.readsClosed).toBe(false);
  });
});

describe("run-scoped answers", () => {
  it("answers only the named panel approval and consumes it once", () => {
    const a = claim("a-chat", "panel", "panel-a");
    const b = claim("b-chat", "panel", "panel-b");
    const answerA = vi.fn();
    const answerB = vi.fn();
    const ask = { steps: ["Send the invoice"], current: 0, reapproval: false };
    a.planApproval = { ask, resolve: answerA };
    b.planApproval = { ask, resolve: answerB };
    expect(answerPlanApproval("missing", true)).toBe(false);
    expect(answerPlanApproval(a.conversationId, true)).toBe(false);
    expect(answerPlanApproval(a.id, false, "Use the work account")).toBe(true);
    expect(answerA).toHaveBeenCalledExactlyOnceWith(false, "Use the work account");
    expect(answerB).not.toHaveBeenCalled();
    expect(answerPlanApproval(a.id, true)).toBe(false);
    expect(b.planApproval).toBeDefined();
  });

  it("rejects approval answers after abort or from a non-panel owner", () => {
    const panel = claim("panel-chat", "panel", "panel");
    const bridge = claim("bridge-chat", "bridge", "client");
    const resolve = vi.fn();
    const ask = { steps: ["Send"], current: 0, reapproval: false };
    panel.planApproval = { ask, resolve };
    bridge.planApproval = { ask, resolve };
    panel.controller.abort();
    expect(answerPlanApproval(panel.id, true)).toBe(false);
    expect(answerPlanApproval(bridge.id, true)).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("requires the run and request IDs to match an elicitation", () => {
    const a = claim("a-chat", "panel", "a");
    const b = claim("b-chat", "panel", "b");
    const answerA = vi.fn();
    const answerB = vi.fn();
    a.elicitation = { requestId: "request-a", resolve: answerA };
    b.elicitation = { requestId: "request-b", resolve: answerB };
    expect(answerElicitation(a.id, "request-b", "accept", { account: "work" })).toBe(false);
    expect(answerElicitation(b.id, "request-a", "accept")).toBe(false);
    expect(answerElicitation(a.id, "request-a", "accept", { account: "work" })).toBe(true);
    expect(answerA).toHaveBeenCalledExactlyOnceWith({
      action: "accept",
      value: { account: "work" },
    });
    expect(answerB).not.toHaveBeenCalled();
    expect(answerElicitation(a.id, "request-a", "accept")).toBe(false);
    expect(answerElicitation(b.id, "request-b", "decline", { ignored: true })).toBe(true);
    expect(answerB).toHaveBeenCalledExactlyOnceWith({ action: "decline" });
  });

  it("rejects elicitation answers after abort or from a non-panel owner", () => {
    const panel = claim("panel-chat", "panel", "panel");
    const bridge = claim("bridge-chat", "bridge", "client");
    const resolve = vi.fn();
    panel.elicitation = { requestId: "request", resolve };
    bridge.elicitation = { requestId: "request", resolve };
    panel.controller.abort();
    expect(answerElicitation(panel.id, "request", "accept")).toBe(false);
    expect(answerElicitation(bridge.id, "request", "accept")).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
  });
});
