import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command, Event } from "@/shared/protocol";
import { PORT_NAME } from "@/shared/protocol";
import { useConversationStore } from "../ui/store";
import { runModePref } from "@/lib/prefs";

/**
 * The real store against a fake port, checking what actually goes on the wire.
 *
 * A stop with queued messages is a redirect, not a halt: the joined queued text
 * must auto-run as the next task once the old run has fully unwound. The wiring
 * is sequencing, so it is the store's most fragile behavior. The run mode
 * rides along here because it decides what every one of those sends carries.
 *
 * The base chrome stub (test-setup) has no `runtime` — this test adds the two
 * bits the store touches: `runtime.connect` (the port seam) and `tabs.query`.
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

beforeEach(async () => {
  port = makePort();
  // The run mode is a stored preference the store re-reads on connect, so the
  // pin has to be in both places — the state below for the synchronous read
  // sendTask does, and storage for the connect read that lands right after.
  await runModePref.set("background");
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
    lastRun: null,
    runMode: "background",
    pendingStepId: null,
    planMsgId: null,
    queued: [],
    pendingSend: null,
    draft: "",
    drivingTab: null,
  });
});

afterEach(() => useConversationStore.getState().disconnect());

describe("stop auto-sends the queue", () => {
  it("sends the joined queued text as the next task after the run unwinds", async () => {
    const s = useConversationStore.getState();
    s.connect();
    await s.sendTask("original task");
    // The run's home rides the command — where its task message just landed.
    const conversationId = useConversationStore.getState().activeId;
    expect(port.fake.postMessage).toHaveBeenLastCalledWith({
      type: "run",
      conversationId,
      task: "original task",
    });

    s.queueMessage("go back");
    s.queueMessage("then reload");
    s.stop();
    expect(port.fake.postMessage).toHaveBeenLastCalledWith({ type: "stop" });

    port.fireMessage({ type: "done" });

    await vi.waitFor(() =>
      expect(port.fake.postMessage).toHaveBeenLastCalledWith({
        type: "run",
        conversationId,
        task: "go back\nthen reload",
      }),
    );
    expect(useConversationStore.getState().queued).toEqual([]);
  });

  it("keeps a plain halt when nothing is queued", async () => {
    const s = useConversationStore.getState();
    s.connect();
    await s.sendTask("original task");
    const conversationId = useConversationStore.getState().activeId;

    s.stop();
    port.fireMessage({ type: "done" });
    await Promise.resolve();

    expect(port.fake.postMessage).not.toHaveBeenCalledWith({
      type: "run",
      conversationId,
      task: "go back",
    });
    expect(useConversationStore.getState().status).toBe("idle");
  });

  it("recalls the queue to the composer when the run ends on its own", async () => {
    const s = useConversationStore.getState();
    s.connect();
    await s.sendTask("original task");
    const conversationId = useConversationStore.getState().activeId;
    s.queueMessage("go back");

    port.fireMessage({ type: "done" });
    await Promise.resolve();

    expect(port.fake.postMessage).not.toHaveBeenCalledWith({
      type: "run",
      conversationId,
      task: "go back",
    });
    expect(useConversationStore.getState().queued).toEqual([]);
    expect(useConversationStore.getState().draft).toBe("go back");
  });

  it("starts every panel from the stored run mode, not the built-in default", async () => {
    // The mode is a habit, not a per-run decision — and a background run closes
    // the panel itself, so "held in panel state" meant losing it every time.
    await runModePref.set("foreground");
    useConversationStore.setState({ runMode: "background" });

    useConversationStore.getState().connect();
    await vi.waitFor(() => expect(useConversationStore.getState().runMode).toBe("foreground"));

    // And the flip writes it back, so the next panel opens where this one left.
    useConversationStore.getState().setRunMode("background");
    expect(await runModePref.get()).toBe("background");
  });

  it("preserves the pending text across a second stop", async () => {
    const s = useConversationStore.getState();
    s.connect();
    await s.sendTask("original task");
    const conversationId = useConversationStore.getState().activeId;
    s.queueMessage("go back");

    s.stop();
    s.stop();
    port.fireMessage({ type: "done" });

    await vi.waitFor(() =>
      expect(port.fake.postMessage).toHaveBeenLastCalledWith({
        type: "run",
        conversationId,
        task: "go back",
      }),
    );
  });
});
