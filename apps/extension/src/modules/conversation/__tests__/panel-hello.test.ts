import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command, Event } from "@/shared/protocol";
import { PORT_NAME } from "@/shared/protocol";
import { useConversationStore } from "../ui/store";

/**
 * The panel names its window on connect. The worker gates every OS notification
 * on "is the user watching?", and that question is only answerable per-window:
 * a panel open in window A while the user works in window B is on nobody's
 * screen. A port that never says hello is treated as watching, so losing this
 * message costs notifications with no error anywhere — hence a test on the one
 * observable fact, that connecting puts the window id on the wire.
 */

interface FakePort {
  postMessage: ReturnType<typeof vi.fn<(cmd: Command) => void>>;
  onMessage: { addListener: (fn: (e: Event) => void) => void; removeListener: () => void };
  onDisconnect: { addListener: (fn: () => void) => void; removeListener: () => void };
  disconnect: () => void;
  name: string;
}

function makePort(): FakePort {
  return {
    name: PORT_NAME,
    postMessage: vi.fn<(cmd: Command) => void>(),
    onMessage: { addListener: () => {}, removeListener: () => {} },
    onDisconnect: { addListener: () => {}, removeListener: () => {} },
    disconnect: () => {},
  };
}

let port: FakePort;

function install(getCurrent: () => Promise<{ id?: number }>) {
  port = makePort();
  (globalThis as Record<string, unknown>).chrome = {
    runtime: { connect: () => port as unknown as chrome.runtime.Port },
    tabs: { query: async () => [] },
    windows: { getCurrent },
  };
}

beforeEach(() => useConversationStore.getState().disconnect());
afterEach(() => useConversationStore.getState().disconnect());

describe("panel hello", () => {
  it("announces the panel's window on connect", async () => {
    install(async () => ({ id: 7 }));
    useConversationStore.getState().connect();
    await vi.waitFor(() =>
      expect(port.postMessage).toHaveBeenCalledWith({ type: "hello", windowId: 7 }),
    );
  });

  it("connects anyway when the window id is unavailable", async () => {
    install(() => Promise.reject(new Error("no window")));
    useConversationStore.getState().connect();
    // The port still works — query_run went out, and no unhandled rejection
    // took the connect down with it.
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledWith({ type: "query_run" }));
    const sent = port.postMessage.mock.calls.map(([cmd]) => cmd.type);
    expect(sent).not.toContain("hello");
  });
});
