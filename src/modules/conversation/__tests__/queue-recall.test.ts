import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command } from "@/shared/protocol";
import { PORT_NAME } from "@/shared/protocol";
import { useConversationStore } from "../ui/store";

/**
 * ↑ on an empty composer takes the WHOLE queue back, not just the newest line.
 * The one-at-a-time recall this replaced stranded everything below the last
 * entry: the pop filled the composer, and from a filled composer ↑ walks the
 * sent history instead — so the first thing you queued was unreachable.
 */
const postMessage = vi.fn<(cmd: Command) => void>();

beforeEach(() => {
  postMessage.mockClear();
  const noop = { addListener: () => {}, removeListener: () => {} };
  (globalThis as Record<string, unknown>).chrome = {
    runtime: {
      connect: () => ({
        name: PORT_NAME,
        postMessage,
        onMessage: noop,
        onDisconnect: noop,
        disconnect: () => {},
      }),
    },
  };
  useConversationStore.setState({ queued: [], draft: "" });
});
afterEach(() => useConversationStore.getState().disconnect());

describe("recallQueued", () => {
  it("merges every queued line into one draft and unqueues them all on the wire", () => {
    const s = useConversationStore.getState();
    s.queueMessage("open the second result");
    s.queueMessage("then save the pdf");
    const ids = useConversationStore.getState().queued.map((q) => q.id);
    expect(ids).toHaveLength(2);

    s.recallQueued();

    const after = useConversationStore.getState();
    expect(after.draft).toBe("open the second result\nthen save the pdf");
    expect(after.queued).toEqual([]);
    // The loop keeps its own copy of the queue — every line has to be dropped
    // there too, or the run steers with text the composer is now holding.
    for (const id of ids) expect(postMessage).toHaveBeenCalledWith({ type: "unqueue", id });
  });

  it("leaves an empty queue alone rather than clobbering the draft", () => {
    useConversationStore.setState({ draft: "half a thought" });
    useConversationStore.getState().recallQueued();
    expect(useConversationStore.getState().draft).toBe("half a thought");
  });
});
