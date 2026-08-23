import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command, Event } from "@/shared/protocol";
import { PORT_NAME } from "@/shared/protocol";
import { useConversationStore } from "../ui/store";

/**
 * Stop is a halt, not an eraser: the plan card and the approval prompt are run
 * artifacts the user still needs after the run unwinds. Drives the real store
 * against a fake port, same seam as store-autosend.test.ts.
 */

interface FakePort {
  postMessage: ReturnType<typeof vi.fn>;
  onMessage: { addListener: (fn: (e: Event) => void) => void; removeListener: () => void };
  onDisconnect: { addListener: (fn: () => void) => void; removeListener: () => void };
  disconnect: () => void;
  name: string;
}

let port: { fake: FakePort; fireMessage: (e: Event) => void };

function makePort(): { fake: FakePort; fireMessage: (e: Event) => void } {
  const message: Array<(e: Event) => void> = [];
  const fake: FakePort = {
    name: PORT_NAME,
    postMessage: vi.fn<(cmd: Command) => void>(),
    onMessage: {
      addListener: (fn) => message.push(fn),
      removeListener: () => {},
    },
    onDisconnect: {
      addListener: () => {},
      removeListener: () => {},
    },
    disconnect: () => {},
  };
  return { fake, fireMessage: (e) => message.forEach((fn) => fn(e)) };
}

beforeEach(() => {
  port = makePort();
  (globalThis as Record<string, unknown>).chrome = {
    runtime: { connect: () => port.fake as unknown as chrome.runtime.Port },
    tabs: {
      query: async () => [
        { id: 1, active: true, currentWindow: true, url: "https://example.com", title: "Example" },
      ],
    },
    windows: { getCurrent: async () => ({ id: 1 }) },
  };
  useConversationStore.getState().disconnect();
  useConversationStore.setState({
    messages: [],
    conversations: [],
    activeId: null,
    status: "idle",
    streamingText: "",
    reasoningText: "",
    reasoningStartedAt: null,
    usage: { input: 0, output: 0 },
    runStartedAt: null,
    runEndedAt: null,
    runStopped: false,
    replanning: false,
    lastRun: null,
    pendingStepId: null,
    planMsgId: null,
    planApproval: null,
    queued: [],
    pendingSend: null,
    draft: "",
    drivingTab: null,
  });
});

afterEach(() => useConversationStore.getState().disconnect());

describe("stop preserves the plan card", () => {
  it("keeps the plan message after stop + done", async () => {
    const s = useConversationStore.getState();
    s.connect();
    await s.sendTask("do the thing");

    port.fireMessage({ type: "plan", steps: ["step one", "step two", "step three"], current: 1 });
    expect(useConversationStore.getState().messages.some((m) => m.role === "plan")).toBe(true);

    s.stop();
    port.fireMessage({ type: "done" });
    await Promise.resolve();

    const planMsg = useConversationStore.getState().messages.find((m) => m.role === "plan");
    expect(planMsg?.steps).toEqual(["step one", "step two", "step three"]);
    expect(planMsg?.current).toBe(1);
  });
});

describe("plan approval prompt", () => {
  it("arms the card on plan_approval and posts the answer", async () => {
    const s = useConversationStore.getState();
    s.connect();
    await s.sendTask("do the thing");

    port.fireMessage({ type: "plan_approval", steps: ["a", "b"], current: 0, reapproval: false });
    expect(useConversationStore.getState().planApproval).toMatchObject({
      steps: ["a", "b"],
      current: 0,
      reapproval: false,
    });

    useConversationStore.getState().approvePlan();
    expect(port.fake.postMessage).toHaveBeenLastCalledWith({
      type: "plan_approval",
      approved: true,
    });
    expect(useConversationStore.getState().planApproval).toBeNull();
  });

  it("posts a rejection the same way", async () => {
    const s = useConversationStore.getState();
    s.connect();
    await s.sendTask("do the thing");

    port.fireMessage({ type: "plan_approval", steps: ["a"], current: 0, reapproval: true });
    useConversationStore.getState().rejectPlan();
    expect(port.fake.postMessage).toHaveBeenLastCalledWith({
      type: "plan_approval",
      approved: false,
    });
    expect(useConversationStore.getState().planApproval).toBeNull();
  });

  it("posts a revision with the note and records it as a user message", async () => {
    const s = useConversationStore.getState();
    s.connect();
    await s.sendTask("do the thing");

    port.fireMessage({ type: "plan_approval", steps: ["a", "b"], current: 0, reapproval: false });
    useConversationStore.getState().revisePlan("  skip step b  ");
    expect(port.fake.postMessage).toHaveBeenLastCalledWith({
      type: "plan_approval",
      approved: false,
      feedback: "skip step b",
    });
    const state = useConversationStore.getState();
    expect(state.planApproval).toBeNull();
    expect(state.messages.at(-1)).toMatchObject({ role: "user", content: "skip step b" });
  });

  it("flags the revision window and clears it when the revised plan arrives", async () => {
    const s = useConversationStore.getState();
    s.connect();
    await s.sendTask("do the thing");

    port.fireMessage({ type: "plan_approval", steps: ["a", "b"], current: 0, reapproval: false });
    useConversationStore.getState().revisePlan("skip b");
    // The band names the gap between the note and the revised plan.
    expect(useConversationStore.getState().replanning).toBe(true);

    port.fireMessage({ type: "plan_approval", steps: ["a"], current: 0, reapproval: true });
    expect(useConversationStore.getState().replanning).toBe(false);
  });

  it("clears the revision window when the run ends while redrafting", async () => {
    const s = useConversationStore.getState();
    s.connect();
    await s.sendTask("do the thing");

    port.fireMessage({ type: "plan_approval", steps: ["a", "b"], current: 0, reapproval: false });
    useConversationStore.getState().revisePlan("skip b");
    expect(useConversationStore.getState().replanning).toBe(true);

    port.fireMessage({ type: "error", message: "boom" });
    expect(useConversationStore.getState().replanning).toBe(false);
  });

  it("ignores a blank revision note — the prompt stays parked", async () => {
    const s = useConversationStore.getState();
    s.connect();
    await s.sendTask("do the thing");

    port.fireMessage({ type: "plan_approval", steps: ["a"], current: 0, reapproval: false });
    useConversationStore.getState().revisePlan("   ");
    expect(useConversationStore.getState().planApproval).not.toBeNull();
    expect(port.fake.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "plan_approval" }),
    );
  });

  it("clears a parked prompt when the run ends without an answer", async () => {
    const s = useConversationStore.getState();
    s.connect();
    await s.sendTask("do the thing");

    port.fireMessage({ type: "plan_approval", steps: ["a"], current: 0, reapproval: false });
    expect(useConversationStore.getState().planApproval).not.toBeNull();

    s.stop();
    expect(useConversationStore.getState().planApproval).toBeNull();
  });
});
