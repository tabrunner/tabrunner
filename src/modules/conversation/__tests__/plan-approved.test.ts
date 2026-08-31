import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command, Event } from "@/shared/protocol";
import { PORT_NAME } from "@/shared/protocol";
import { useConversationStore } from "../ui/store";

/**
 * The planApproved lifecycle the background auto-close keys on: a run starts
 * unapproved, earns the handover on approve, re-arms on a revision, and resets
 * with the run. (The walk-away button does not key on this — it disables only
 * while an answer is parked: a plan gate or a server's question.) Drives the
 * real store against a fake port, same seam as plan-stop.test.ts.
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
    usage: { input: 0, output: 0 },
    runStartedAt: null,
    runEndedAt: null,
    lastRun: null,
    planApproval: null,
    planApproved: false,
  });
});

afterEach(() => useConversationStore.getState().disconnect());

describe("planApproved lifecycle (background auto-close)", () => {
  it("starts gated, opens on approve, re-arms on a revision", async () => {
    const s = useConversationStore.getState();
    s.connect();
    await s.sendTask("do the thing");
    expect(useConversationStore.getState().planApproved).toBe(false);

    port.fireMessage({ type: "plan_approval", steps: ["a", "b"], current: 0, reapproval: false });
    useConversationStore.getState().approvePlan();
    expect(useConversationStore.getState().planApproved).toBe(true);

    // Sent back for changes: the REVISED plan must earn the walk-away back.
    port.fireMessage({ type: "plan_approval", steps: ["a", "b"], current: 0, reapproval: true });
    expect(useConversationStore.getState().planApproved).toBe(false);
    useConversationStore.getState().revisePlan("skip step b");
    expect(useConversationStore.getState().planApproved).toBe(false);

    port.fireMessage({ type: "plan_approval", steps: ["a"], current: 0, reapproval: true });
    useConversationStore.getState().approvePlan();
    expect(useConversationStore.getState().planApproved).toBe(true);
  });

  it("resets when the run ends and on the next run", async () => {
    const s = useConversationStore.getState();
    s.connect();
    await s.sendTask("do the thing");
    port.fireMessage({ type: "plan_approval", steps: ["a"], current: 0, reapproval: false });
    useConversationStore.getState().approvePlan();
    expect(useConversationStore.getState().planApproved).toBe(true);

    port.fireMessage({ type: "done" });
    await Promise.resolve();
    expect(useConversationStore.getState().planApproved).toBe(false);

    await useConversationStore.getState().sendTask("another thing");
    expect(useConversationStore.getState().planApproved).toBe(false);
  });
});
