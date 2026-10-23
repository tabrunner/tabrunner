import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The run strip shows only what the rest of this chat cannot: other runs and
// queued tasks. Each row's Stop must target that run, never a shared slot.

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { RunningRun } from "@/modules/agent/run-queue";
import { setI18n } from "react-i18next";
import { i18n } from "@/i18n";
import { RunBoard } from "../ui/RunBoard";
import { useConversationStore } from "../ui/store";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => setI18n(i18n));

const roots: Root[] = [];
async function render() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<RunBoard />));
  return { container, root };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const HERE = "conversation-here";
const ELSEWHERE = "conversation-elsewhere";

function running(id: string, conversationId: string, task: string): RunningRun {
  return {
    id,
    conversationId,
    owner: "panel",
    ownerId: `panel:${conversationId}`,
    task,
    startedAt: 1,
  };
}

function queued(id: string, conversationId: string, task: string) {
  return {
    id,
    conversationId,
    owner: "panel" as const,
    ownerId: `panel:${conversationId}`,
    task,
    enqueuedAt: 0,
  };
}

beforeEach(() => {
  useConversationStore.setState({
    activeId: HERE,
    activeRunId: null,
    board: { running: [], pendingQuestions: [], queue: [] },
    queuedRun: null,
  });
});

describe("run board", () => {
  it("says nothing about the run this chat is already showing", async () => {
    useConversationStore.setState({
      board: {
        running: [running("run-here", HERE, "Book the flight")],
        pendingQuestions: [],
        queue: [],
      },
    });

    const { container } = await render();
    expect(container.querySelector("section")).toBeNull();
  });

  it("names a run driving another conversation", async () => {
    useConversationStore.setState({
      board: {
        running: [running("run-there", ELSEWHERE, "Book the flight")],
        pendingQuestions: [],
        queue: [],
      },
    });

    const { container } = await render();
    expect(container.textContent).toContain("Book the flight");
  });

  it("drops our own queued card and keeps the line's real numbering", async () => {
    useConversationStore.setState({
      board: {
        running: [running("run-there", ELSEWHERE, "Running")],
        pendingQuestions: [],
        queue: [queued("mine", HERE, "My queued task"), queued("theirs", ELSEWHERE, "Their task")],
      },
      queuedRun: { id: "mine", position: 1, task: "My queued task" },
    });

    const { container } = await render();
    expect(container.textContent).not.toContain("My queued task");
    expect(container.textContent).toContain("Their task");
    expect(container.textContent).toContain("2");
  });

  it("shows two simultaneous runs and stops only the selected row", async () => {
    const stop = vi
      .spyOn(useConversationStore.getState(), "stopRunById")
      .mockImplementation(() => {});
    useConversationStore.setState({
      board: {
        running: [
          running("run-first", ELSEWHERE, "Book the flight"),
          running("run-second", "conversation-third", "Read the invoice"),
        ],
        pendingQuestions: [],
        queue: [],
      },
    });
    const { container } = await render();
    expect(container.textContent).toContain("Book the flight");
    expect(container.textContent).toContain("Read the invoice");
    const buttons = container.querySelectorAll<HTMLButtonElement>('button[aria-label="Stop"]');
    expect(buttons).toHaveLength(2);
    await act(async () => buttons[1]!.click());
    expect(stop).toHaveBeenCalledExactlyOnceWith("run-second");
    expect(buttons[0]?.disabled).toBe(false);
    expect(buttons[1]?.disabled).toBe(true);
  });
});
