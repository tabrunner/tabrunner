import { beforeAll, describe, expect, it } from "vitest";

// Regression check for the jump-to-latest pill. The shadcn scroller's
// `scrollable.end` means "unseen content below the viewport" (the old
// !stuck), so the pill must be ABSENT while following the live edge and
// PRESENT once the reader scrolls away. The adoption initially mapped it
// onto the old `stuck` and rendered on !stuck — the pill showed forever
// exactly at the bottom. jsdom has no layout: the scrolled-away half stubs
// viewport/item metrics, the following half needs none.

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { setI18n } from "react-i18next";
import { i18n } from "@/i18n";
import type { Message } from "../types";
import { MessageList } from "../ui/MessageList";
import { useConversationStore } from "../ui/store";

// react-dom/client act opt-in (no testing-library in this repo).
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no element scrollTo; the scroller primitive uses it for every
// programmatic jump, so without this the jumps (and the regression below)
// would never materialize. Covers both overload forms — (options) and (x, y).
Element.prototype.scrollTo = function (
  this: Element,
  optsOrX?: ScrollToOptions | number,
  y?: number,
) {
  this.scrollTop = typeof optsOrX === "number" ? (y ?? 0) : (optsOrX?.top ?? 0);
};

// test-setup inits the shared instance but never registers it with
// react-i18next; without this useTranslation finds no instance.
beforeAll(() => setI18n(i18n));

const MESSAGES: Message[] = [
  { id: "u1", role: "user", content: "Summarize the page", timestamp: 0 },
  { id: "a1", role: "assistant", content: "Done.", timestamp: 1 },
];

const PILL = "Answer ready ↓";

async function renderList(): Promise<{ container: HTMLElement; root: Root }> {
  useConversationStore.setState({
    messages: MESSAGES,
    status: "idle",
    streamingText: "",
    reasoningText: "",
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<MessageList />));
  return { container, root };
}

async function unmount({ container, root }: { container: HTMLElement; root: Root }) {
  await act(async () => root.unmount());
  container.remove();
}

const pill = (container: HTMLElement) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === PILL);

/** jsdom has no layout: give the viewport a 200px window over 1000px of rows. */
function stubTallTranscript(container: HTMLElement): HTMLElement {
  const viewport = container.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]')!;
  Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 200 });
  viewport.getBoundingClientRect = () => new DOMRect(0, 0, 300, 200);
  for (const item of container.querySelectorAll<HTMLElement>(
    '[data-slot="message-scroller-item"]',
  )) {
    item.getBoundingClientRect = () => new DOMRect(0, 0, 300, 1000);
  }
  return viewport;
}

describe("MessageList jump pill", () => {
  it("is hidden while the reader follows the live edge", async () => {
    const view = await renderList();
    expect(pill(view.container)).toBeUndefined();
    await unmount(view);
  });

  it("appears once the reader scrolls away, and clicking it returns to the edge", async () => {
    const view = await renderList();
    const viewport = stubTallTranscript(view.container);
    // The wheel marks user scroll intent (following → free-scrolling); the
    // scroll commit then measures the stubbed geometry — 800px of rows below
    // the window, past the 80px stick threshold.
    await act(async () => {
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, bubbles: true }));
      viewport.dispatchEvent(new Event("scroll"));
    });
    const button = pill(view.container);
    expect(button).toBeDefined();
    // Clicking jumps to the end and re-engages following — the pill clears.
    await act(async () => button!.click());
    expect(pill(view.container)).toBeUndefined();
    await unmount(view);
  });

  it('says "jump to latest" while running, "answer ready" once the run ends', async () => {
    const findPill = (c: HTMLElement) =>
      [...c.querySelectorAll("button")].find((b) => b.textContent?.includes("↓"));
    useConversationStore.setState({
      messages: MESSAGES,
      status: "running",
      streamingText: "",
      reasoningText: "",
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<MessageList />));
    const viewport = stubTallTranscript(container);
    await act(async () => {
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, bubbles: true }));
      viewport.dispatchEvent(new Event("scroll"));
    });
    expect(findPill(container)?.textContent).toBe("Jump to latest ↓");

    // The run ends while the reader is scrolled up — the pill names the
    // answer that landed, instead of a bare "scroll down".
    await act(async () => {
      useConversationStore.setState({ status: "idle" });
    });
    expect(findPill(container)?.textContent).toBe("Answer ready ↓");
    await act(async () => root.unmount());
    container.remove();
  });
});

/**
 * Scroll-aware layout: the viewport is a 200px window over `rows` 100px rows,
 * and item rects track scrollTop so the primitive's document-space math holds.
 */
function stubScrollLayout(container: HTMLElement, rows: number): HTMLElement {
  const viewport = container.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]')!;
  Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 200 });
  Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: rows * 100 });
  viewport.getBoundingClientRect = () => new DOMRect(0, 0, 300, 200);
  [...container.querySelectorAll<HTMLElement>('[data-slot="message-scroller-item"]')].forEach(
    (item, i) => {
      item.getBoundingClientRect = () => {
        const top = i * 100 - viewport.scrollTop;
        return new DOMRect(0, top, 300, 100);
      };
    },
  );
  return viewport;
}

describe("transcript scroll on settle", () => {
  // Regression for shadcn-ui/ui#11128 (fixed upstream post-0.3.0, carried as a
  // bun patch): mount-time anchors never enter the handled set, so a
  // same-count swap — the working dots replaced by the error bubble — took
  // the "count unchanged" branch and yanked the reader to the oldest anchor.
  const SEED: Message[] = [
    { id: "u1", role: "user", content: "first task", timestamp: 0 },
    { id: "a1", role: "assistant", content: "first reply", timestamp: 1 },
    { id: "u2", role: "user", content: "second task", timestamp: 2 },
  ];

  it("a same-count settle swap keeps the reader at the live edge", async () => {
    // Running: three messages + the working-dots row = four items.
    useConversationStore.setState({ messages: SEED, status: "running" });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<MessageList />));
    const viewport = stubScrollLayout(container, 4);
    // Commit the stubbed geometry so following-bottom holds at the bottom.
    await act(async () => {
      viewport.scrollTop = 200;
      viewport.dispatchEvent(new Event("scroll"));
    });
    expect(viewport.scrollTop).toBe(200);

    // The run dies: the dots row is replaced by the error bubble — four items
    // in, four items out, so the scroller takes its "count unchanged" branch.
    await act(async () => {
      useConversationStore.setState({
        messages: [...SEED, { id: "e1", role: "error", content: "boom", timestamp: 4 }],
        status: "error",
        streamingText: "",
        reasoningText: "",
      });
      await new Promise((r) => setTimeout(r));
    });

    expect(viewport.scrollTop).toBe(200);
    await act(async () => root.unmount());
    container.remove();
  });
});

describe("error bubble", () => {
  async function renderError(msg: Message): Promise<HTMLElement> {
    useConversationStore.setState({
      messages: [{ id: "u1", role: "user", content: "do the thing", timestamp: 0 }, msg],
      status: "error",
      streamingText: "",
      reasoningText: "",
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<MessageList />));
    return container;
  }

  it("a provider-classified error shows its lead only — no paraphrasing hint line", async () => {
    const content =
      'Provider error: Anthropic is rate-limiting requests — try again in a moment: {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit."}}';
    const container = await renderError({
      id: "e1",
      role: "error",
      content,
      kind: "rate",
      timestamp: 1,
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Anthropic is rate-limiting requests — try again in a moment");
    // The dedup: the generic hint paraphrases the lead, so it must not render.
    expect(text).not.toContain("Rate limited — wait a moment, then send again.");
  });

  it("an unclassified error keeps the generic regex hint", async () => {
    const container = await renderError({
      id: "e1",
      role: "error",
      content: "Provider error: 429 rate limit hit",
      timestamp: 1,
    });
    expect(container.textContent ?? "").toContain("Rate limited — wait a moment, then send again.");
  });
});

describe("ask_user chips", () => {
  // Regression: the chips gate used to require the question card to be the LAST
  // message. The sentence the model streams alongside its ask_user call is
  // flushed after the card at run end — landing between the card and the chips
  // gate and dead-ending the one question that needed an answer.
  const ASK: Message[] = [
    { id: "u1", role: "user", content: "Import the files", timestamp: 0 },
    {
      id: "q1",
      role: "step",
      tool: "ask_user",
      content: "Which files should I import?",
      args: { choices: ["waitlist.csv", "users.csv"] },
      timestamp: 1,
    },
  ];

  async function renderAsk(messages: Message[]): Promise<HTMLElement> {
    useConversationStore.setState({ messages, status: "idle", streamingText: "" });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<MessageList />));
    return container;
  }

  const chip = (container: HTMLElement, label: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === label);

  it("stays tappable when the model's parting sentence landed after the card", async () => {
    const container = await renderAsk([
      ...ASK,
      { id: "a1", role: "assistant", content: "Let me check which files you mean.", timestamp: 2 },
    ]);
    expect(chip(container, "waitlist.csv")).toBeDefined();
  });

  it("drops the chips once the user replied", async () => {
    const container = await renderAsk([
      ...ASK,
      { id: "u2", role: "user", content: "waitlist.csv", timestamp: 2 },
    ]);
    expect(chip(container, "waitlist.csv")).toBeUndefined();
  });

  it("an open question (no choices) names where the answer goes, until answered", async () => {
    const OPEN: Message[] = [
      { id: "u1", role: "user", content: "Import the files", timestamp: 0 },
      {
        id: "q1",
        role: "step",
        tool: "ask_user",
        content: "What are the exact file names?",
        timestamp: 1,
      },
    ];
    const awaiting = await renderAsk(OPEN);
    expect(
      [...awaiting.querySelectorAll("span")].find(
        (s) => s.textContent === "Type your answer below",
      ),
    ).toBeDefined();

    const answered = await renderAsk([
      ...OPEN,
      { id: "u2", role: "user", content: "waitlist.csv and users.csv", timestamp: 2 },
    ]);
    expect(
      [...answered.querySelectorAll("span")].find(
        (s) => s.textContent === "Type your answer below",
      ),
    ).toBeUndefined();
  });
});

describe("a stopped run", () => {
  it("marks the halt and keeps the model's progress note out of the chat", async () => {
    useConversationStore.setState({
      messages: [
        { id: "u1", role: "user", content: "book the flight", timestamp: 0 },
        {
          id: "s1",
          role: "step",
          tool: "snapshot",
          content: "Captured 154 elements",
          timestamp: 1,
        },
        {
          id: "m1",
          role: "step",
          content: "You stopped this run — your next message can pick up from here.",
          timestamp: 2,
        },
        {
          id: "n1",
          role: "assistant",
          content: "The user stopped this run before it finished. What it had already done:",
          internal: true,
          timestamp: 3,
        },
      ],
      status: "idle",
      streamingText: "",
      reasoningText: "",
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<MessageList />));

    const text = container.textContent ?? "";
    expect(text).toContain("You stopped this run");
    // The note is the next run's history, never a bubble talking past the user.
    expect(text).not.toContain("The user stopped this run");

    await act(async () => root.unmount());
    container.remove();
  });
});

describe("transcript scroll when the run finishes", () => {
  // A run settling mid-read: the working-dots row vanishes and the burst flips
  // live→settled. If the reader scrolled up to follow along, the settle must
  // not yank them — least of all to the top.
  const SEED: Message[] = [
    { id: "u1", role: "user", content: "rank the domains", timestamp: 0 },
    { id: "s1", role: "step", tool: "snapshot", content: "Captured 154 elements", timestamp: 1 },
    { id: "s2", role: "step", tool: "click", content: "Clicked", timestamp: 2 },
  ];

  it("a done-settle while scrolled up does not scroll to top", async () => {
    useConversationStore.setState({ messages: SEED, status: "running" });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<MessageList />));
    // seed(3) + burst grouping may fold steps — give the layout 6 rows.
    const viewport = stubScrollLayout(container, 6);
    // The reader scrolled UP — off the live edge, mid-transcript.
    await act(async () => {
      viewport.scrollTop = 100;
      viewport.dispatchEvent(new Event("scroll"));
    });
    expect(viewport.scrollTop).toBe(100);

    // The run finishes: done with a summary lands, dots vanish, burst settles.
    await act(async () => {
      useConversationStore.setState({
        messages: [...SEED, { id: "a2", role: "assistant", content: "The answer.", timestamp: 3 }],
        status: "idle",
        streamingText: "",
        reasoningText: "",
      });
      await new Promise((r) => setTimeout(r));
    });

    // The burst must NOT have snapped shut — a controlled open-on-live would
    // fold the transcript under a scrolled-up reader (that shrink is what the
    // scroller reads as a cue to re-follow the bottom).
    expect(container.querySelector("details")?.open).toBe(true);
    await act(async () => root.unmount());
    container.remove();
  });
});

/**
 * The bug-report affordance is opt-in and must stay that way: almost every
 * error in the catalog is an anticipated condition with its own cause and fix
 * (a chrome:// page, a rate limit, a closed tab), and offering "Report on
 * GitHub" next to those would both invite noise and bury the real remedy.
 * Only text nobody authored — a raw exception, an unreadable provider failure
 * — carries `unexpected`.
 */
describe("error bubble report affordance", () => {
  const RESTRICTED =
    "TabRunner can't read this page — Chrome blocks extensions on chrome:// and Web Store pages. Navigate the tab to a regular page and resend the task.";

  async function renderError(msg: Omit<Message, "id" | "role" | "timestamp">) {
    useConversationStore.setState({
      messages: [{ id: "e1", role: "error", timestamp: 0, ...msg }],
      status: "idle",
      streamingText: "",
      reasoningText: "",
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<MessageList />));
    return { container, root };
  }

  const reportLink = (c: HTMLElement) =>
    [...c.querySelectorAll("a")].find((a) => a.textContent === "Report on GitHub");

  it("stays away from an anticipated condition", async () => {
    const view = await renderError({ content: RESTRICTED });
    expect(reportLink(view.container)).toBeUndefined();
    await unmount(view);
  });

  it("stays away from a classified provider state", async () => {
    const view = await renderError({
      content: "Anthropic is rate-limiting requests — try again in a moment",
      kind: "rate",
    });
    expect(reportLink(view.container)).toBeUndefined();
    await unmount(view);
  });

  it("offers a pre-filled issue for text nobody wrote copy for", async () => {
    const view = await renderError({
      content: "Cannot read properties of undefined (reading 'targetId')",
      unexpected: true,
    });
    const link = reportLink(view.container);
    expect(link).toBeDefined();
    const url = new URL(link!.href);
    expect(url.pathname).toBe("/tabrunner/tabrunner/issues/new");
    expect(url.searchParams.get("title")).toContain("Cannot read properties");
    await unmount(view);
  });

  it("yields to a hint even when unexpected — connectivity advice beats a bug report", async () => {
    const view = await renderError({ content: "Failed to fetch", unexpected: true });
    expect(reportLink(view.container)).toBeUndefined();
    await unmount(view);
  });
});

describe("MessageList assistant copy", () => {
  it("offers a copy that writes the message's markdown source", async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (text: string) => {
          written.push(text);
          return Promise.resolve();
        },
      },
    });
    const view = await renderList();
    const button = [...view.container.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === i18n.t("chat.copyMessage"),
    );
    expect(button).toBeDefined();
    await act(async () => button!.click());
    expect(written).toEqual(["Done."]);
    await unmount(view);
  });
});
