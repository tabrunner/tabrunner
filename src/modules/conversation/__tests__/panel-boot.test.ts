import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command, Event } from "@/shared/protocol";
import { PORT_NAME } from "@/shared/protocol";
import { useConversationStore } from "../ui/store";
import { appendMessageFresh, setActiveConversation } from "../conversations";

/**
 * What the panel's open owes the user.
 *
 * `hydrated` is the flag the boot cover comes off on (App.tsx), so it must flip
 * exactly once the open conversation's transcript is on screen — never before
 * (the panel would show its "nothing here yet" hero over a thread that exists)
 * and never not at all (the cover would never lift).
 *
 * And the read that sets it must lose every race it can lose: the composer is
 * live the moment the panel paints, this read is at its slowest on the first
 * open of the day, and a send that beats it has already put the user's message
 * on screen and minted the thread it belongs to. Painting storage over that
 * erased the message — which is why every other storage repaint of `messages`
 * consults ownsLiveView, and now so does this one.
 */

interface FakePort {
  postMessage: ReturnType<typeof vi.fn<(cmd: Command) => void>>;
  onMessage: { addListener: (fn: (e: Event) => void) => void; removeListener: () => void };
  onDisconnect: { addListener: (fn: () => void) => void; removeListener: () => void };
  disconnect: () => void;
  name: string;
}

let port: FakePort;

beforeEach(() => {
  port = {
    name: PORT_NAME,
    postMessage: vi.fn<(cmd: Command) => void>(),
    onMessage: { addListener: () => {}, removeListener: () => {} },
    onDisconnect: { addListener: () => {}, removeListener: () => {} },
    disconnect: () => {},
  };
  (globalThis as Record<string, unknown>).chrome = {
    runtime: { connect: () => port as unknown as chrome.runtime.Port },
    tabs: {
      query: async () => [{ id: 1, active: true, url: "https://example.com", title: "Example" }],
    },
    windows: { getCurrent: async () => ({ id: 1 }) },
  };
  useConversationStore.getState().disconnect();
  useConversationStore.setState({
    messages: [],
    activeId: null,
    hydrated: false,
    status: "idle",
    lastRun: null,
  });
});

afterEach(() => useConversationStore.getState().disconnect());

/** Yesterday's thread, stored and left open — what a cold panel reopens onto. */
async function storeOpenConversation(): Promise<string> {
  const id = await appendMessageFresh({
    id: "m1",
    role: "user",
    content: "yesterday's task",
    timestamp: 1,
  });
  await setActiveConversation(id);
  return id;
}

describe("panel boot", () => {
  it("hydrates the open conversation and settles", async () => {
    const id = await storeOpenConversation();

    useConversationStore.getState().connect();

    await vi.waitFor(() => expect(useConversationStore.getState().hydrated).toBe(true));
    const state = useConversationStore.getState();
    expect(state.activeId).toBe(id);
    expect(state.messages.map((m) => m.content)).toEqual(["yesterday's task"]);
  });

  it("settles on a panel with nothing stored", async () => {
    useConversationStore.getState().connect();

    await vi.waitFor(() => expect(useConversationStore.getState().hydrated).toBe(true));
    expect(useConversationStore.getState().activeId).toBeNull();
    expect(useConversationStore.getState().messages).toEqual([]);
  });

  it("never erases a message sent before the read lands", async () => {
    await storeOpenConversation();

    const s = useConversationStore.getState();
    s.connect();
    // No await between the two: the send beats the transcript read, exactly as
    // typing into a panel that has just painted does.
    await s.sendTask("today's task");

    await vi.waitFor(() => expect(useConversationStore.getState().hydrated).toBe(true));
    const state = useConversationStore.getState();
    expect(state.messages.map((m) => m.content)).toContain("today's task");
    // And the thread the message went to is still the one the panel is on.
    expect(state.activeId).not.toBeNull();
  });
});
