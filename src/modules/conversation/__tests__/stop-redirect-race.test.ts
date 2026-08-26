import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command, Event } from "@/shared/protocol";
import { PORT_NAME } from "@/shared/protocol";
import { useConversationStore } from "../ui/store";
import { runModePref } from "@/lib/prefs";
import * as conversations from "../conversations";
import { fireStorageWatch } from "@/test-setup";
import type { Message } from "../types";

// The redirect's refetch race is timing: the board watch reads storage before
// the redirected message lands, then its refetch resolves after the store has
// shown the message — and wipes it. Mock getMessages to hand the watch a stale
// snapshot that resolves late, exactly the interleaving the worker produces.
vi.mock("../conversations", async (importOriginal) => {
  const actual = await importOriginal<typeof conversations>();
  return { ...actual, getMessages: vi.fn(actual.getMessages) };
});

interface FakePort {
  postMessage: ReturnType<typeof vi.fn>;
  onMessage: { addListener: (fn: (e: Event) => void) => void; removeListener: () => void };
  onDisconnect: { addListener: (fn: () => void) => void; removeListener: () => void };
  disconnect: () => void;
  name: string;
}
let port: { fake: FakePort; fireMessage: (e: Event) => void };
function makePort() {
  const message: Array<(e: Event) => void> = [];
  const fake: FakePort = {
    name: PORT_NAME,
    postMessage: vi.fn<(cmd: Command) => void>(),
    onMessage: { addListener: (fn) => message.push(fn), removeListener: () => {} },
    onDisconnect: { addListener: () => {}, removeListener: () => {} },
    disconnect: () => {},
  };
  return { fake, fireMessage: (e: Event) => message.forEach((fn) => fn(e)) };
}

let releaseTabQuery: (() => void) | undefined;

beforeEach(async () => {
  port = makePort();
  releaseTabQuery = undefined;
  await runModePref.set("background");
  (globalThis as Record<string, unknown>).chrome = {
    runtime: { connect: () => port.fake as unknown as chrome.runtime.Port },
    tabs: {
      query: () =>
        new Promise((resolve) => {
          releaseTabQuery = () =>
            resolve([{ id: 1, url: "https://example.com", title: "Example" }]);
        }),
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
  vi.mocked(conversations.getMessages).mockRestore();
});
afterEach(() => useConversationStore.getState().disconnect());

describe("stop-redirect survives the board refetch race", () => {
  it("keeps the redirected message when a stale refetch resolves after it", async () => {
    const s = useConversationStore.getState();
    s.connect();
    void s.sendTask("original task");
    await vi.waitFor(() => expect(releaseTabQuery).toBeDefined());
    releaseTabQuery!();
    await vi.waitFor(() =>
      expect(port.fake.postMessage).toHaveBeenCalledWith({
        type: "run",
        conversationId: expect.any(String),
        task: "original task",
      }),
    );
    const conversationId = useConversationStore.getState().activeId!;

    // The worker's board write — the snapshot storage holds at that moment.
    const stale = await conversations.getMessages(conversationId);
    const mocked = vi.mocked(conversations.getMessages);
    // Every refetch this test causes hands back a deferred, resolved by the
    // test in the order the run's real interleaving would resolve them.
    const pending: Array<(rows: Message[]) => void> = [];
    mocked.mockImplementation((id) => {
      if (id !== conversationId) return Promise.resolve(stale);
      return new Promise((resolve) => {
        pending.push(resolve);
      });
    });

    // The run claims the board so the release below looks like "this run left".
    // (This first board write also refetches — resolve it with the real rows.)
    fireStorageWatch("run-board", {
      running: { conversationId, task: "original task", owner: "panel", startedAt: Date.now() },
      queue: [],
    });
    await vi.waitFor(() => expect(pending.length).toBe(1));
    pending.shift()!(stale);
    await Promise.resolve();

    s.queueMessage("go back");
    s.stop();
    // The redirect parks at tabs.query — `sending` is true, status idle.
    port.fireMessage({ type: "done" });

    // Index-watch half of the fix: mid-handoff (idle but owning — `sending`),
    // an index write must not even START a refetch. The board claim above
    // satisfies this watch's own "the run lives here" check, so ownership is
    // the only guard left between the stale index and the live view. Under the
    // fixed code no fetch begins; without the fire-guard term one would queue
    // here and wipe the redirected message the moment it resolves late.
    fireStorageWatch("conversations", [
      { id: conversationId, title: "original task", createdAt: Date.now(), updatedAt: Date.now() },
    ]);
    await Promise.resolve();
    expect(pending.length).toBe(0);

    // The slot releases: the board watch refetches and reads the stale rows.
    fireStorageWatch("run-board", { queue: [] });
    await vi.waitFor(() => expect(pending.length).toBe(1));
    await Promise.resolve();

    // The redirect lands its message, then the stale refetch resolves while
    // sendTask is still awaiting its storage write — status is still idle, so
    // the old guard (status !== "running") lets the stale snapshot through.
    releaseTabQuery!();
    pending.shift()!(stale);
    await vi.waitFor(() =>
      expect(port.fake.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: "run", task: "go back" }),
      ),
    );

    const msgs = useConversationStore.getState().messages;
    expect(msgs.some((m) => m.role === "user" && m.content === "go back")).toBe(true);
  });
});
