import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command, Event } from "@/shared/protocol";
import { PORT_NAME } from "@/shared/protocol";
import type { Message } from "../types";
import { retryTargetFrom, useConversationStore } from "../ui/store";

/**
 * Retry resends the transcript's newest user message — derived from the
 * transcript, not panel state, so a reopened panel (lastRun died with the
 * close) still offers it. Drives the real store against a fake port, same
 * seam as plan-approved.test.ts.
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

function runCommands(): Command[] {
  return port.fake.postMessage.mock.calls.map(([c]) => c).filter((c) => c.type === "run");
}

beforeEach(() => {
  port = makePort();
  (globalThis as Record<string, unknown>).chrome = {
    runtime: { connect: () => port.fake as unknown as chrome.runtime.Port },
    tabs: { query: async () => [] },
    windows: { getCurrent: async () => ({ id: 1 }) },
  };
  useConversationStore.getState().disconnect();
  useConversationStore.setState({
    messages: [],
    conversations: [],
    activeId: null,
    status: "idle",
    usage: { input: 0, output: 0 },
    runStartedAt: null,
    runEndedAt: null,
    lastRun: null,
    planApproval: null,
    planApproved: false,
  });
});

afterEach(() => useConversationStore.getState().disconnect());

describe("retry", () => {
  it("resends the newest user message with its mode — lastRun long gone", () => {
    const messages: Message[] = [
      { id: "u1", role: "user", content: "first task", timestamp: 0 },
      { id: "a1", role: "assistant", content: "first reply", timestamp: 1 },
      {
        id: "u2",
        role: "user",
        content: "second task",
        images: ["data:image/png;base64,x"],
        tab: { title: "Example", url: "https://example.com" },
        timestamp: 2,
      },
      { id: "e1", role: "error", content: "boom", timestamp: 3 },
    ];
    // The reopened panel: nothing of the dispatching session survived.
    useConversationStore.setState({ messages, status: "error", lastRun: null, activeId: "c1" });

    useConversationStore.getState().retry();

    // The stamp is history, not a mode to restore: the retry is an ordinary
    // send, and it adopts whatever tab the user is on now.
    expect(runCommands()).toEqual([
      {
        type: "run",
        conversationId: "c1",
        task: "second task",
        images: ["data:image/png;base64,x"],
      },
    ]);
    // No duplicate user row — the failed attempt sits right above the error.
    expect(useConversationStore.getState().messages.filter((m) => m.role === "user")).toHaveLength(
      2,
    );
  });

  it("an unstamped message retries the same way", () => {
    useConversationStore.setState({
      messages: [
        { id: "u1", role: "user", content: "do the thing", timestamp: 0 },
        { id: "e1", role: "error", content: "boom", timestamp: 1 },
      ],
      status: "error",
      activeId: "c1",
    });

    useConversationStore.getState().retry();

    expect(runCommands()).toEqual([{ type: "run", conversationId: "c1", task: "do the thing" }]);
  });

  it("a run its tab outlived retries by putting the page back first", () => {
    useConversationStore.setState({
      messages: [
        { id: "u1", role: "user", content: "book the flight", timestamp: 0 },
        {
          id: "e1",
          role: "error",
          content: "The tab this task was driving (Flights) was closed",
          tab: { title: "Flights", url: "https://flights.example/search?q=1" },
          timestamp: 1,
        },
      ],
      status: "error",
      activeId: "c1",
    });

    useConversationStore.getState().retry();

    // Named url, so the run reopens that page instead of adopting whatever the
    // user moved to after closing the tab.
    expect(runCommands()).toEqual([
      {
        type: "run",
        conversationId: "c1",
        task: "book the flight",
        url: "https://flights.example/search?q=1",
      },
    ]);
  });

  it("no user message above the error → no run, no crash", () => {
    useConversationStore.setState({
      messages: [{ id: "e1", role: "error", content: "boom", timestamp: 0 }],
      status: "error",
    });

    useConversationStore.getState().retry();

    expect(runCommands()).toEqual([]);
    expect(useConversationStore.getState().status).toBe("error");
  });

  it("a run in flight blocks the retry", () => {
    useConversationStore.setState({
      messages: [
        { id: "u1", role: "user", content: "do the thing", timestamp: 0 },
        { id: "e1", role: "error", content: "boom", timestamp: 1 },
      ],
      status: "running",
    });

    useConversationStore.getState().retry();

    expect(runCommands()).toEqual([]);
  });
});

describe("retryTargetFrom", () => {
  it("ignores everything after the newest user message", () => {
    const target = retryTargetFrom([
      { id: "u1", role: "user", content: "task", timestamp: 0 },
      { id: "s1", role: "step", content: "read page", timestamp: 1 },
      { id: "a1", role: "assistant", content: "progress note", timestamp: 2 },
      { id: "e1", role: "error", content: "boom", timestamp: 3 },
    ]);
    expect(target).toEqual({ task: "task" });
  });

  it("an empty transcript has nothing to retry", () => {
    expect(retryTargetFrom([])).toBeNull();
  });

  it("carries the page a closed tab took with it — newest error wins", () => {
    const target = retryTargetFrom([
      { id: "u1", role: "user", content: "task", timestamp: 0 },
      {
        id: "e1",
        role: "error",
        content: "tab closed",
        tab: { title: "Old", url: "https://old.example" },
        timestamp: 1,
      },
      {
        id: "e2",
        role: "error",
        content: "tab closed again",
        tab: { title: "New", url: "https://new.example" },
        timestamp: 2,
      },
    ]);
    expect(target).toEqual({ task: "task", url: "https://new.example" });
  });

  it("a closed tab from before the user's message is settled history", () => {
    const target = retryTargetFrom([
      {
        id: "e1",
        role: "error",
        content: "tab closed",
        tab: { title: "Old", url: "https://old.example" },
        timestamp: 0,
      },
      { id: "u1", role: "user", content: "task", timestamp: 1 },
      { id: "e2", role: "error", content: "boom", timestamp: 2 },
    ]);
    // The user has sent a message since — they said where to work by sending it.
    expect(target).toEqual({ task: "task" });
  });
});
