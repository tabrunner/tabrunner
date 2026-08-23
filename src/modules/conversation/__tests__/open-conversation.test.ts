import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command, Event } from "@/shared/protocol";
import { PORT_NAME } from "@/shared/protocol";
import { getActiveId } from "../conversations";
import { useConversationStore } from "../ui/store";

/**
 * A conversation switch re-asks the worker what is live: the parked plan gate
 * and the driven-tab chip re-arm only on a fresh query_run, and the worker
 * scopes its answer to the active slot — so the slot write must land first.
 * Without the re-ask, switching back to a parked conversation showed "waiting
 * for your approval" with the approval card gone. Same fake-port seam as
 * plan-stop.test.ts.
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

const queryRuns = (): Command[] =>
  port.fake.postMessage.mock.calls.map(([c]) => c).filter((c) => c.type === "query_run");

beforeEach(() => {
  port = makePort();
  (globalThis as Record<string, unknown>).chrome = {
    runtime: { connect: () => port.fake as unknown as chrome.runtime.Port },
    tabs: { query: async () => [] },
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

describe("openConversation", () => {
  it("re-asks what is live, naming the thread it just switched to", async () => {
    useConversationStore.getState().connect();
    port.fake.postMessage.mockClear(); // the connect's own query_run

    useConversationStore.getState().openConversation("c1");

    await vi.waitFor(() => expect(queryRuns()).toHaveLength(1));
    // Named on the command, not left to the shared slot: a panel open in
    // another window can point that slot elsewhere between the write and the
    // worker reading it, and the answer would be about the wrong thread.
    expect(queryRuns()[0]).toEqual({ type: "query_run", conversationId: "c1" });
    expect(await getActiveId()).toBe("c1");
  });

  it("the answer re-arms the gate the switch had reset", async () => {
    useConversationStore.getState().connect();
    useConversationStore.getState().openConversation("c1");
    await vi.waitFor(() => expect(queryRuns()).not.toHaveLength(0));

    port.fireMessage({ type: "plan_approval", steps: ["a", "b"], current: 0, reapproval: false });

    expect(useConversationStore.getState().planApproval).toMatchObject({
      steps: ["a", "b"],
      current: 0,
      reapproval: false,
    });
  });

  it("re-opening the conversation already open asks nothing", async () => {
    useConversationStore.getState().connect();
    port.fake.postMessage.mockClear();
    useConversationStore.setState({ activeId: "c1" });

    useConversationStore.getState().openConversation("c1");

    await new Promise((r) => setTimeout(r, 20));
    expect(queryRuns()).toHaveLength(0);
  });
});
