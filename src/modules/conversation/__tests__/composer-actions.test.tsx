import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The composer's two behaviors: the morph button (one slot — ↑ Send/Queue
// whenever there's text, ■ Stop only while steering with an empty input) and
// the run-mode control, which is a two-state preference while idle and
// becomes the walk-away action ("Run in background") while a run of this
// panel's own is live. Plus the run band's plan peek, which unfolds the steps
// it had to hide. Same createRoot+act seam as chat-input-slash.test.tsx.

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { setI18n } from "react-i18next";
import { i18n } from "@/i18n";
import { getMessages } from "../conversations";
import { ChatInput } from "../ui/ChatInput";
import { HelpDialog } from "../ui/HelpDialog";
import { setHelpOpen } from "../ui/help-open";
import { RunModeToggle } from "../ui/RunModeToggle";
import { RunStatus } from "../ui/RunStatus";
import { useConversationStore } from "../ui/store";
import type { RunSummary } from "../conversations";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => setI18n(i18n));

interface Harness {
  container: HTMLElement;
  root: Root;
}

async function render(ui: React.ReactElement): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(ui));
  return { container, root };
}

async function unmount({ container, root }: Harness) {
  await act(async () => root.unmount());
  container.remove();
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

const morphButton = (h: Harness, label: string) =>
  h.container.querySelector(`button[aria-label="${label}"]`);

beforeEach(() => {
  useConversationStore.setState({
    messages: [],
    conversations: [],
    activeId: null,
    draft: "",
    pastedTexts: [],
    collapseDisabled: false,
    runMode: "foreground",
    status: "idle",
    usage: { input: 0, output: 0 },
    runStartedAt: null,
    runEndedAt: null,
    planApproval: null,
    planApproved: false,
    queued: [],
    queuedRun: null,
    board: { queue: [] },
    drivingTab: null,
    bridgeActive: null,
  });
});

afterEach(() => vi.restoreAllMocks());

describe("morph button", () => {
  it("is a disabled Send when idle with an empty input", async () => {
    const h = await render(<ChatInput />);
    const send = morphButton(h, "Send");
    expect(send).not.toBeNull();
    expect((send as HTMLButtonElement).disabled).toBe(true);
    expect(morphButton(h, "Stop")).toBeNull();
    await unmount(h);
  });

  it("is Stop while steering with an empty input, Queue once there's text", async () => {
    useConversationStore.setState({ status: "running", runStartedAt: Date.now() });
    const h = await render(<ChatInput />);
    expect(morphButton(h, "Stop")).not.toBeNull();
    expect(morphButton(h, "Send")).toBeNull();

    await act(async () => useConversationStore.getState().setDraft("keep going"));
    expect(morphButton(h, "Queue")).not.toBeNull();
    expect(morphButton(h, "Stop")).toBeNull();
    await unmount(h);
  });

  it("never stops while our own run only waits in the queue", async () => {
    useConversationStore.setState({
      queuedRun: { id: "q1", position: 1, task: "next thing" },
      board: {
        queue: [
          { id: "q1", conversationId: "c1", owner: "panel", task: "next thing", enqueuedAt: 1 },
        ],
      },
    });
    const h = await render(<ChatInput />);
    expect(morphButton(h, "Stop")).toBeNull();
    expect(morphButton(h, "Send")).not.toBeNull();
    await unmount(h);
  });
});

describe("the parked plan gate", () => {
  it("typed text answers the gate instead of queueing behind a run that cannot move", async () => {
    useConversationStore.setState({
      status: "running",
      runStartedAt: Date.now(),
      planApproval: { steps: ["a"], current: 0, reapproval: false },
      draft: "isso",
      activeId: "gate-note",
    });
    const h = await render(<ChatInput />);
    // The composer names where the text goes — never "add to the running task",
    // because a parked run has no tool boundary a queued line could land at.
    const area = h.container.querySelector("textarea")!;
    expect(area.placeholder).toBe("Approve the plan above, or type what should change…");

    const send = morphButton(h, "Send the plan back with your note");
    expect(send).not.toBeNull();
    await click(send!);

    const st = useConversationStore.getState();
    expect(st.queued).toEqual([]);
    expect(st.planApproval).toBeNull();
    // The band switches to "Revising the plan…" until the new card arrives.
    expect(st.replanning).toBe(true);
    expect(st.draft).toBe("");
    // The note lands as a user message — the transcript shows what the plan was
    // sent back with. Written, not painted: every panel showing the thread had
    // the card, so the worker's plan_answered echo is what draws it in each of
    // them (plan-stop.test.ts covers that half).
    await vi.waitFor(async () =>
      expect(await getMessages("gate-note")).toContainEqual(
        expect.objectContaining({ role: "user", content: "isso" }),
      ),
    );
    await unmount(h);
  });
});

describe("run mode: a preference while idle, the walk-away while running", () => {
  const toggleButton = (h: Harness) => {
    const btn = h.container.querySelector("button");
    if (!btn) throw new Error("no toggle");
    return btn;
  };

  it("idle with an old plan card: the flip is only a preference", async () => {
    useConversationStore.setState({
      messages: [{ id: "m1", role: "plan", content: "", steps: ["a"], timestamp: 1000 }],
    });
    const close = vi.spyOn(window, "close").mockImplementation(() => {});
    const h = await render(<RunModeToggle />);
    expect(toggleButton(h).textContent).toBe("In foreground");
    await click(toggleButton(h));
    expect(useConversationStore.getState().runMode).toBe("background");
    expect(close).not.toHaveBeenCalled();
    await unmount(h);
  });

  it("live run past the plan gate: the control is the walk-away action", async () => {
    useConversationStore.setState({
      status: "running",
      runStartedAt: Date.now(),
      planApproved: true,
    });
    const close = vi.spyOn(window, "close").mockImplementation(() => {});
    const h = await render(<RunModeToggle />);
    expect(toggleButton(h).textContent).toBe("Run in background");
    // A trigger, not a switch: the live action dresses in brand, the idle
    // preference stays ghost.
    expect(toggleButton(h).className).toContain("text-brand-700");
    await click(toggleButton(h));
    expect(close).toHaveBeenCalledTimes(1);
    // An act on the run in flight, not a vote on where the next one goes.
    expect(useConversationStore.getState().runMode).toBe("foreground");
    await unmount(h);
  });

  it("parked on the plan approval: the action is there but cannot strand the gate", async () => {
    useConversationStore.setState({
      status: "running",
      runStartedAt: Date.now(),
      planApproval: { steps: ["a"], current: 0, reapproval: false },
    });
    const close = vi.spyOn(window, "close").mockImplementation(() => {});
    const h = await render(<RunModeToggle />);
    expect(toggleButton(h).disabled).toBe(true);
    await click(toggleButton(h));
    expect(close).not.toHaveBeenCalled();
    await unmount(h);
  });
});

describe("the run band's plan peek", () => {
  const PLAN = ["find the listing", "open it", "read the price", "check stock", "report back"];
  // The finished band: a stored last-run summary plus the run's plan card.
  const settled = () => {
    useConversationStore.setState({
      status: "idle",
      activeId: "c1",
      conversations: [
        {
          id: "c1",
          title: "t",
          createdAt: 0,
          updatedAt: 0,
          taskCount: 1,
          lastRun: { startedAt: 0, endedAt: 1000, input: 1, output: 1, ok: true },
        },
      ],
      messages: [{ id: "p1", role: "plan", content: "", steps: PLAN, current: 5, timestamp: 1 }],
    });
  };
  const peek = (h: Harness) =>
    [...h.container.querySelectorAll("button")].find((b) => b.hasAttribute("aria-expanded"));

  it("unfolds the steps it hid, and folds them back", async () => {
    settled();
    const h = await render(<RunStatus />);
    const button = peek(h);
    expect(button).toBeDefined();
    // Collapsed: the window ends at the last step, the earlier ones are counts.
    expect(button!.textContent).not.toContain("find the listing");
    expect(button!.textContent).toContain("5 done · 0 to go");

    await click(button!);
    expect(peek(h)!.textContent).toContain("find the listing");
    await click(peek(h)!);
    expect(peek(h)!.textContent).not.toContain("find the listing");
    await unmount(h);
  });

  it("promises no expansion when the whole plan already fits", async () => {
    settled();
    useConversationStore.setState({
      messages: [
        { id: "p1", role: "plan", content: "", steps: ["one", "two"], current: 1, timestamp: 1 },
      ],
    });
    const h = await render(<RunStatus />);
    expect(peek(h)).toBeUndefined();
    await unmount(h);
  });
});

describe("the finished band's token total", () => {
  // `usage` is summed from the events THIS panel received, and a panel receives
  // none while it is closed — a background run closes it at the plan gate by
  // design. Left to its own sum the band reported the fraction of turns it
  // happened to witness as if it were the whole run: "3m 25s · 15.9k" for a run
  // whose last turn alone sent 15.6k. The writer counted every turn.
  const settledWith = (lastRun: RunSummary) =>
    useConversationStore.setState({
      status: "idle",
      activeId: "c1",
      runStartedAt: 1000,
      runEndedAt: 206_000,
      usage: { input: 15_600, output: 300 },
      conversations: [{ id: "c1", title: "t", createdAt: 0, updatedAt: 0, taskCount: 1, lastRun }],
    });

  const band = (h: Harness) => h.container.textContent ?? "";

  it("prefers the writer's complete count over this panel's partial sum", async () => {
    settledWith({ startedAt: 1000, endedAt: 206_000, input: 88_000, output: 4_100, ok: true });
    const h = await render(<RunStatus />);
    expect(band(h)).toContain("92.1k");
    expect(band(h)).not.toContain("15.9k");
    await unmount(h);
  });

  it("falls back to its own sum in the tick before the summary lands", async () => {
    settledWith({ startedAt: 0, endedAt: 0, input: 0, output: 0, ok: true });
    useConversationStore.setState({ conversations: [] });
    const h = await render(<RunStatus />);
    expect(band(h)).toContain("15.9k");
    await unmount(h);
  });
});

describe("the ? help gesture", () => {
  const pressKey = (h: Harness, key: string) =>
    act(async () => {
      h.container
        .querySelector("textarea")!
        .dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });

  it("opens the sheet only on a pristine composer — with a draft, ? is a character", async () => {
    const h = await render(
      <>
        <ChatInput />
        <HelpDialog />
      </>,
    );
    await act(async () => useConversationStore.getState().setDraft("what does this page say"));
    await pressKey(h, "?");
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => useConversationStore.getState().setDraft(""));
    await pressKey(h, "?");
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    // The command table is generated — one row per registered slash command.
    expect(dialog!.textContent).toContain("/compact");
    // And the gesture never became a draft character.
    expect(useConversationStore.getState().draft).toBe("");
    await unmount(h);
    setHelpOpen(false);
  });
});

describe("the finished band's go-to-tab action", () => {
  // The bare "Go to tab" button became the same chip the live band wears: it
  // NAMES the tab instead of only admitting one exists, and stays visible for
  // the whole settled band rather than reading as a one-shot action.
  const goToTab = (h: Harness) =>
    [...h.container.querySelectorAll("button")].find((b) => b.textContent === "Cart");

  it("names the run's last tab, and the click brings it forward", async () => {
    useConversationStore.setState({
      status: "idle",
      activeId: "c1",
      conversations: [
        {
          id: "c1",
          title: "t",
          createdAt: 0,
          updatedAt: 0,
          taskCount: 1,
          lastRun: { startedAt: 0, endedAt: 1000, input: 1, output: 1, ok: true },
          tabs: [{ url: "https://example.com/cart", title: "Cart", tabId: 42 }],
        },
      ],
    });
    const tabs = {
      update: vi.fn(async () => ({})),
      get: vi.fn(async () => ({ windowId: 7 })),
    };
    const windows = { update: vi.fn(async () => ({})) };
    (globalThis as Record<string, unknown>).chrome = {
      ...((globalThis as Record<string, unknown>).chrome ?? {}),
      tabs,
      windows,
    };
    const h = await render(<RunStatus />);
    const button = goToTab(h);
    expect(button).toBeDefined();

    await click(button!);
    // The user's own click pulls the window too — they asked to see the tab.
    expect(windows.update).toHaveBeenCalledWith(7, { focused: true });
    expect(tabs.update).toHaveBeenCalledWith(42, { active: true });
    await unmount(h);
  });

  it("no tab to go to, no offer", async () => {
    useConversationStore.setState({
      status: "idle",
      activeId: "c1",
      conversations: [
        {
          id: "c1",
          title: "t",
          createdAt: 0,
          updatedAt: 0,
          taskCount: 1,
          lastRun: { startedAt: 0, endedAt: 1000, input: 1, output: 1, ok: true },
        },
      ],
    });
    const h = await render(<RunStatus />);
    expect(goToTab(h)).toBeUndefined();
    await unmount(h);
  });
});
