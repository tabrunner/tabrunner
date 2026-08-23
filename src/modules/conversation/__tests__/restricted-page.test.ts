import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command, Event } from "@/shared/protocol";
import { PORT_NAME } from "@/shared/protocol";
import { useConversationStore } from "../ui/store";
import { runModePref } from "@/lib/prefs";

/**
 * A send from a page Chrome forbids extensions from touching. The task is
 * perfectly runnable — only the page is impossible — so the run opens a tab of
 * its own instead of dying on errors.restrictedPage with the user's message
 * already in the transcript, and the message carries no stamp for a tab nothing
 * drove. Neither depends on the run mode: foreground and background put the
 * same command on the wire, and the mode decides one thing only, whether
 * approving the plan takes the panel with it.
 *
 * Real store against a fake port, same seam as store-autosend.test.ts.
 */

interface FakePort {
  postMessage: ReturnType<typeof vi.fn>;
  onMessage: { addListener: (fn: (e: Event) => void) => void; removeListener: () => void };
  onDisconnect: { addListener: (fn: () => void) => void; removeListener: () => void };
  disconnect: () => void;
  name: string;
}

let port: FakePort;
let activeUrl: string;

function makePort(): FakePort {
  return {
    name: PORT_NAME,
    postMessage: vi.fn<(cmd: Command) => void>(),
    onMessage: { addListener: () => {}, removeListener: () => {} },
    onDisconnect: { addListener: () => {}, removeListener: () => {} },
    disconnect: () => {},
  };
}

function lastRunCommand(): Command | undefined {
  return port.postMessage.mock.calls.map(([c]) => c).findLast((c) => c.type === "run");
}

beforeEach(async () => {
  port = makePort();
  activeUrl = "https://example.com";
  await runModePref.set("foreground");
  (globalThis as Record<string, unknown>).chrome = {
    runtime: { connect: () => port as unknown as chrome.runtime.Port },
    tabs: {
      query: async () => [{ id: 1, active: true, url: activeUrl, title: "Active tab" }],
    },
    windows: { getCurrent: async () => ({ id: 1 }) },
  };
  useConversationStore.getState().disconnect();
  useConversationStore.setState({
    messages: [],
    conversations: [],
    activeId: null,
    status: "idle",
    lastRun: null,
    runMode: "foreground",
    queued: [],
    pendingSend: null,
    draft: "",
  });
});

afterEach(() => useConversationStore.getState().disconnect());

describe("a send from a restricted page", () => {
  it("runs in a tab of its own instead of erroring", async () => {
    activeUrl = "chrome://extensions";
    const s = useConversationStore.getState();
    s.connect();
    await s.sendTask("summarize my inbox");

    expect(lastRunCommand()).toEqual({
      type: "run",
      conversationId: useConversationStore.getState().activeId,
      task: "summarize my inbox",
    });
    // No stamp either — a chrome:// chip under the message would name a tab the
    // run never drove.
    const sent = useConversationStore.getState().messages.findLast((m) => m.role === "user");
    expect(sent?.tab).toBeUndefined();
    expect(useConversationStore.getState().messages.some((m) => m.role === "error")).toBe(false);
  });

  it("does not turn the send into a walk-away", async () => {
    activeUrl = "https://chromewebstore.google.com/detail/tabrunner/abc";
    const s = useConversationStore.getState();
    s.connect();
    await s.sendTask("what is this extension");

    // The user chose to watch. Where the run had to open its tab is not their
    // mode — so approvePlan must not close the panel out from under them.
    expect(useConversationStore.getState().lastRun?.background).toBeUndefined();
  });

  it("stamps an ordinary page with the tab the run adopts", async () => {
    const s = useConversationStore.getState();
    s.connect();
    await s.sendTask("summarize this");

    expect(lastRunCommand()).toEqual({
      type: "run",
      conversationId: useConversationStore.getState().activeId,
      task: "summarize this",
    });
    const sent = useConversationStore.getState().messages.findLast((m) => m.role === "user");
    expect(sent?.tab?.url).toBe("https://example.com");
  });

  // The whole point of the rename: the two modes are one run. If a flag ever
  // creeps back onto the wire, "in background" has quietly become a second
  // setting again — and the label is misleading all over.
  it("sends the same run command in either mode", async () => {
    const s = useConversationStore.getState();
    s.connect();
    await s.sendTask("summarize this");
    const watched = lastRunCommand();
    const watchedStamp = useConversationStore
      .getState()
      .messages.findLast((m) => m.role === "user")?.tab;

    // Back to idle: a second send is refused while one is running.
    useConversationStore.setState({ status: "idle", lastRun: null });
    useConversationStore.getState().setRunMode("background");
    await useConversationStore.getState().sendTask("summarize this");
    const walkedAway = lastRunCommand();
    const walkedStamp = useConversationStore
      .getState()
      .messages.findLast((m) => m.role === "user")?.tab;

    expect(walkedAway).toEqual(watched);
    expect(walkedStamp).toEqual(watchedStamp);
    // The one difference, and it never leaves the panel.
    expect(useConversationStore.getState().lastRun?.background).toBe(true);
  });
});
