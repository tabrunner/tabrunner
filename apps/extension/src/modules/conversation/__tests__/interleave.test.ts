import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Command, Event } from "@/shared/protocol";
import { PORT_NAME } from "@/shared/protocol";
import { useConversationStore } from "../ui/store";
import { TranscriptWriter } from "../transcript";
import { getMessages } from "../conversations";
import { groupBursts } from "../ui/bursts";

/**
 * A run reads in the order it happened. Prose said between two tool calls
 * belongs between their rows — not collected into one bubble under all of
 * them, which is what holding the stream until the run ended produced.
 *
 * The two reducers that decide this are mirrors of one event stream — the
 * panel's `handleEvent` and the worker's `TranscriptWriter` — so the check
 * drives the same script through both and holds them to one expected shape.
 * A flush added to one and forgotten in the other is exactly the drift that
 * makes a reopened conversation disagree with the run you watched.
 */
const SCRIPT: Event[] = [
  { type: "reasoning", text: "the inbox tab is already in front" },
  { type: "token", text: "Opening the inbox." },
  { type: "step_start", tool: "navigate" },
  { type: "step", tool: "navigate", summary: "Navigated to the inbox", ok: true },
  { type: "token", text: "Found the invoice — reading it." },
  { type: "step_start", tool: "snapshot" },
  { type: "step", tool: "snapshot", summary: "Read 24 elements", ok: true },
  { type: "token", text: "Attaching it to the report." },
  { type: "step_start", tool: "click" },
  { type: "step", tool: "click", summary: "Clicked Attach", ok: true },
  { type: "done", summary: "Invoice attached." },
];

/** What both sides must produce — the run, in the order it happened. */
const EXPECTED = [
  ["reasoning", "the inbox tab is already in front"],
  ["assistant", "Opening the inbox."],
  ["step", "Navigated to the inbox"],
  ["assistant", "Found the invoice — reading it."],
  ["step", "Read 24 elements"],
  ["assistant", "Attaching it to the report."],
  ["step", "Clicked Attach"],
  ["assistant", "Invoice attached."],
];

interface FakePort {
  postMessage: ReturnType<typeof vi.fn>;
  onMessage: { addListener: (fn: (e: Event) => void) => void; removeListener: () => void };
  onDisconnect: { addListener: (fn: () => void) => void; removeListener: () => void };
  disconnect: () => void;
  name: string;
}

let port: { fake: FakePort; fireMessage: (e: Event) => void };

beforeEach(() => {
  const listeners: Array<(e: Event) => void> = [];
  const fake: FakePort = {
    name: PORT_NAME,
    postMessage: vi.fn<(cmd: Command) => void>(),
    onMessage: { addListener: (fn) => listeners.push(fn), removeListener: () => {} },
    onDisconnect: { addListener: () => {}, removeListener: () => {} },
    disconnect: () => {},
  };
  port = { fake, fireMessage: (e) => listeners.forEach((fn) => fn(e)) };
  (globalThis as Record<string, unknown>).chrome = {
    runtime: { connect: () => fake as unknown as chrome.runtime.Port },
    tabs: {
      query: async () => [
        {
          id: 1,
          active: true,
          currentWindow: true,
          url: "https://mail.example.com",
          title: "Mail",
        },
      ],
    },
    windows: { getCurrent: async () => ({ id: 1 }) },
  };
  useConversationStore.getState().disconnect();
  useConversationStore.setState({
    messages: [],
    status: "idle",
    streamingText: "",
    reasoningText: "",
    reasoningStartedAt: null,
    pendingStepId: null,
    activeId: null,
  });
});

describe("a run reads in the order it happened", () => {
  it("puts each prose segment where it was said — panel side", async () => {
    const s = useConversationStore.getState();
    s.connect();
    await s.sendTask("attach the latest invoice");
    SCRIPT.forEach((e) => port.fireMessage(e));
    await Promise.resolve();

    const rows = useConversationStore
      .getState()
      .messages.filter((m) => m.role !== "user")
      .map((m) => [m.role, m.content]);
    expect(rows).toEqual(EXPECTED);
    useConversationStore.getState().disconnect();
  });

  it("stores it the same way, so a reopened conversation agrees — writer side", async () => {
    const writer = new TranscriptWriter("interleave-1");
    SCRIPT.forEach((e) => writer.apply(e));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const rows = (await getMessages("interleave-1"))
      .filter((m) => !m.internal)
      .map((m) => [m.role, m.content]);
    expect(rows).toEqual(EXPECTED);
  });

  it("leaves each lone tool call as its own row instead of one burst of them all", async () => {
    const writer = new TranscriptWriter("interleave-2");
    SCRIPT.forEach((e) => writer.apply(e));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Prose between the calls breaks the run, so nothing folds: three separate
    // actions, each announced by the line above it.
    const shape = groupBursts(await getMessages("interleave-2")).map((item) =>
      item.kind === "burst" ? "burst" : item.msg.role,
    );
    expect(shape).toEqual([
      "reasoning",
      "assistant",
      "step",
      "assistant",
      "step",
      "assistant",
      "step",
      "assistant",
    ]);
  });
});
