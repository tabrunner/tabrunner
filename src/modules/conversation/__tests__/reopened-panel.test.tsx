import { beforeAll, describe, expect, it } from "vitest";

// A panel opened onto a run already in flight — the on-page pill's click, or a
// second window on the same thread — holds no run state of its own: `status`
// reads idle. Keyed to that, the transcript treated the live run as finished:
// the tail burst closed with a ✓ and folded every row behind it, leaving a
// panel that looked empty while the agent worked. Liveness comes from the
// shared `runsHere` predicate (this panel's stream OR the board's run on this
// conversation), so the transcript agrees with the band above the composer.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { setI18n } from "react-i18next";
import { i18n } from "@/i18n";
import type { Message } from "../types";
import { MessageList } from "../ui/MessageList";
import { useConversationStore } from "../ui/store";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollTo = function (this: Element) {};

beforeAll(() => setI18n(i18n));

const MESSAGES: Message[] = [
  { id: "u1", role: "user", content: "Get those keys", timestamp: 0 },
  {
    id: "s1",
    role: "step",
    tool: "navigate",
    content: "Opened the console",
    ok: true,
    timestamp: 1,
  },
  { id: "r1", role: "reasoning", content: "the button is below the fold", timestamp: 2 },
  {
    id: "s2",
    role: "step",
    tool: "click",
    content: "Clicked Generate key",
    ok: true,
    timestamp: 3,
  },
];

const BOARD_RUN = {
  running: { conversationId: "c1", task: "Get those keys", owner: "panel" as const, startedAt: 0 },
  queue: [],
};

async function render(board: typeof BOARD_RUN | { queue: [] }) {
  useConversationStore.setState({
    messages: MESSAGES,
    activeId: "c1",
    // The reopened panel's own run state — dead with the close it survived.
    status: "idle",
    streamingText: "",
    reasoningText: "",
    planApproval: null,
    board,
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<MessageList />));
  return {
    container,
    burst: container.querySelector("details"),
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe("a panel watching a run it did not start", () => {
  it("keeps the tail burst open and says the run is still working", async () => {
    const { container, burst, cleanup } = await render(BOARD_RUN);
    expect(burst?.open).toBe(true);
    expect(container.textContent).toContain("Clicked Generate key");
    // No live row can reach a panel with no stream, so the dots are its only
    // in-transcript sign the run is alive.
    expect(container.querySelector('[aria-label="Working"]')).not.toBeNull();
    await cleanup();
  });

  it("still settles the burst once no run owns the conversation", async () => {
    const { container, burst, cleanup } = await render({ queue: [] });
    expect(burst?.open).toBe(false);
    expect(container.querySelector('[aria-label="Working"]')).toBeNull();
    await cleanup();
  });
});
