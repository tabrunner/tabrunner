import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command, PanelMessage } from "@/shared/protocol";
import { PORT_NAME } from "@/shared/protocol";
import { useConversationStore } from "../ui/store";

/**
 * A run's events now go to EVERY open panel, not just the one that dispatched
 * it — the side panel is per-window, and a second window on the same thread used
 * to sit on the last run's token count with a plan card nobody could dismiss.
 *
 * Two rules make that safe, and both live above the event switch:
 *   - a stamped event belongs to one conversation, and a panel showing another
 *     one drops it;
 *   - a panel that did not dispatch the run adopts the stream, because while it
 *     reads idle the transcript refetch would fight the live rows it is drawing.
 *
 * Same fake-port seam as plan-stop.test.ts.
 */

interface FakePort {
  postMessage: ReturnType<typeof vi.fn>;
  onMessage: { addListener: (fn: (m: PanelMessage) => void) => void; removeListener: () => void };
  onDisconnect: { addListener: (fn: () => void) => void; removeListener: () => void };
  disconnect: () => void;
  name: string;
}

let port: { fake: FakePort; fireMessage: (m: PanelMessage) => void };

function makePort() {
  const message: Array<(m: PanelMessage) => void> = [];
  const fake: FakePort = {
    name: PORT_NAME,
    postMessage: vi.fn<(cmd: Command) => void>(),
    onMessage: { addListener: (fn) => message.push(fn), removeListener: () => {} },
    onDisconnect: { addListener: () => {}, removeListener: () => {} },
    disconnect: () => {},
  };
  return { fake, fireMessage: (m: PanelMessage) => message.forEach((fn) => fn(m)) };
}

/** The board as a watching panel sees it — someone else's run, already going. */
const boardRun = (conversationId: string, owner: "panel" | "schedule" = "panel") => ({
  running: { conversationId, task: "Get those keys", owner, startedAt: 1000 },
  queue: [],
});

beforeEach(async () => {
  port = makePort();
  (globalThis as Record<string, unknown>).chrome = {
    runtime: { connect: () => port.fake as unknown as chrome.runtime.Port },
    tabs: { query: async () => [] },
    windows: { getCurrent: async () => ({ id: 1 }) },
  };
  useConversationStore.getState().disconnect();
  useConversationStore.setState({
    messages: [],
    activeId: "c1",
    status: "idle",
    streamingText: "",
    reasoningText: "",
    usage: { input: 0, output: 0 },
    contextTokens: 0,
    runStartedAt: null,
    runEndedAt: null,
    lastRun: null,
    planApproval: null,
    board: { queue: [] },
  });
  useConversationStore.getState().connect();
  // connect() seeds `board` and `activeId` from storage asynchronously; let
  // those land before a test stages the board it wants.
  await new Promise((r) => setTimeout(r, 0));
  useConversationStore.setState({ activeId: "c1" });
});

afterEach(() => useConversationStore.getState().disconnect());

describe("a stamped event reaches only the thread it names", () => {
  it("drops a run event for a conversation this panel is not showing", () => {
    useConversationStore.setState({ board: boardRun("c2") });
    port.fireMessage({ type: "token", text: "not for you", conversationId: "c2" });
    port.fireMessage({
      type: "plan_approval",
      steps: ["Open the console"],
      current: 0,
      reapproval: false,
      conversationId: "c2",
    });

    const s = useConversationStore.getState();
    expect(s.streamingText).toBe("");
    expect(s.planApproval).toBeNull();
    expect(s.status).toBe("idle");
  });

  it("applies an event stamped with the open conversation", () => {
    useConversationStore.setState({ board: boardRun("c1") });
    port.fireMessage({ type: "token", text: "on it", conversationId: "c1" });

    expect(useConversationStore.getState().streamingText).toBe("on it");
  });

  it("applies an unstamped reply — it was never broadcast", () => {
    port.fireMessage({ type: "run_active", active: { mode: "run", client: "Claude Code" } });

    expect(useConversationStore.getState().bridgeActive).toEqual({
      mode: "run",
      client: "Claude Code",
    });
  });
});

describe("following the conversation another window opened", () => {
  it("lands on it and asks what is live there", () => {
    useConversationStore.setState({
      messages: [{ id: "m", role: "user", content: "old", timestamp: 0 }],
    });
    port.fake.postMessage.mockClear();

    useConversationStore.getState().followActive("c9");

    const s = useConversationStore.getState();
    expect(s.activeId).toBe("c9");
    expect(s.messages).toEqual([]);
    expect(port.fake.postMessage).toHaveBeenCalledWith({
      type: "query_run",
      conversationId: "c9",
    });
  });

  it("keeps the half-typed message — another window changed the subject, not the user", () => {
    useConversationStore.setState({ draft: "check the invoice tot", collapseDisabled: true });

    useConversationStore.getState().followActive("c9");

    const s = useConversationStore.getState();
    expect(s.draft).toBe("check the invoice tot");
    expect(s.collapseDisabled).toBe(true);
    // Everything a switch DOES reset still resets.
    expect(s.planApproval).toBeNull();
    expect(s.status).toBe("idle");
  });

  it("stands aside while a send is in flight", async () => {
    useConversationStore.setState({ runTarget: "background" });
    const send = useConversationStore.getState().sendTask("book the flights");
    // The slot moves mid-send — the message must still land where it was aimed.
    useConversationStore.getState().followActive("c9");
    expect(useConversationStore.getState().activeId).toBe("c1");
    await send;
  });
});

describe("adopting a run this panel did not dispatch", () => {
  it("goes live on the run's own clock, not on panel-open", () => {
    useConversationStore.setState({ board: boardRun("c1") });
    port.fireMessage({ type: "step_start", tool: "navigate", conversationId: "c1" });

    const s = useConversationStore.getState();
    expect(s.status).toBe("running");
    expect(s.runStartedAt).toBe(1000);
    // Nothing of ours dispatched it — so nothing here may claim it did.
    expect(s.lastRun).toBeNull();
  });

  it("drops the last run's numbers instead of dressing a new run in them", () => {
    useConversationStore.setState({
      board: boardRun("c1"),
      usage: { input: 40_000, output: 900 },
      contextTokens: 24_300,
    });
    port.fireMessage({ type: "step_start", tool: "navigate", conversationId: "c1" });

    const s = useConversationStore.getState();
    expect(s.usage).toEqual({ input: 0, output: 0 });
    expect(s.contextTokens).toBe(0);
  });

  it("leaves a schedule run alone — the transcript refetch is its only sync path", () => {
    useConversationStore.setState({ board: boardRun("c1", "schedule") });
    port.fireMessage({ type: "step_start", tool: "navigate", conversationId: "c1" });

    // Idle keeps the conversation-index watch pulling what the worker writes.
    // Adopting would switch that off and then wait for a `done` a schedule run
    // never sends to a panel.
    expect(useConversationStore.getState().status).toBe("idle");
  });

  it("takes the run's spend from one absolute usage event", () => {
    useConversationStore.setState({
      board: boardRun("c1"),
      // What the LAST run left behind.
      usage: { input: 40_000, output: 900 },
      contextTokens: 24_300,
    });
    // A panel that opened mid-run saw no deltas; query_run answers with totals.
    port.fireMessage({
      type: "usage",
      input: 12_000,
      output: 340,
      contextTokens: 8_100,
      conversationId: "c1",
    });

    const s = useConversationStore.getState();
    // Set, not added to what was already there.
    expect(s.usage).toEqual({ input: 12_000, output: 340 });
    // The window's occupancy is the last turn's input, not the running total.
    expect(s.contextTokens).toBe(8_100);
  });

  it("drops the gate's card when another window answers it", () => {
    useConversationStore.setState({
      board: boardRun("c1"),
      status: "running",
      planApproval: { steps: ["Open the console", "Copy the key"], current: 0, reapproval: false },
      planApproved: false,
    });
    // Approved in the other window — this panel posted nothing.
    port.fireMessage({ type: "plan_answered", approved: true, conversationId: "c1" });

    const s = useConversationStore.getState();
    expect(s.planApproval).toBeNull();
    // The gate is behind the run here too, so the walk-away unlocks.
    expect(s.planApproved).toBe(true);
    expect(s.replanning).toBe(false);
  });

  it("says 'revising' for a revision and stays quiet for a plain rejection", () => {
    useConversationStore.setState({
      board: boardRun("c1"),
      status: "running",
      planApproval: { steps: ["a"], current: 0, reapproval: false },
    });
    port.fireMessage({ type: "plan_answered", approved: false, conversationId: "c1" });
    // A bare rejection ends the run — promising a revised card would be a lie.
    expect(useConversationStore.getState().replanning).toBe(false);

    useConversationStore.setState({
      planApproval: { steps: ["a"], current: 0, reapproval: false },
    });
    port.fireMessage({
      type: "plan_answered",
      approved: false,
      feedback: "skip step b",
      conversationId: "c1",
    });
    const s = useConversationStore.getState();
    expect(s.replanning).toBe(true);
    expect(s.messages.at(-1)).toMatchObject({ role: "user", content: "skip step b" });
  });

  it("does not revive a settled panel on a straggler", () => {
    // The board is already clear — the run released its slot.
    port.fireMessage({
      type: "compacted",
      messages: 4,
      before: 900,
      after: 200,
      conversationId: "c1",
    });

    expect(useConversationStore.getState().status).toBe("idle");
  });
});
