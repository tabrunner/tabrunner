import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../loop";
import type { BrowserDriver } from "@/modules/browser";
import type { SnapshotResult } from "@/modules/browser/snapshot";
import type { ChatProvider } from "@/modules/providers/types";

// Storage stand-in and i18n come from src/test-setup.ts (vitest setupFiles).

const snapshot = async (): Promise<SnapshotResult> => ({
  pageContent: "Page [ref=e1]",
  viewport: { width: 800, height: 600 },
  url: "https://example.com",
  title: "Example",
  newRefs: 0,
});

const driver = { snapshot } as unknown as BrowserDriver;

/** A provider stuck before its request exists: a refresh that never answers, a Chrome call that never returns. */
function hungProvider(started: () => void): ChatProvider {
  return {
    // eslint-disable-next-line require-yield -- never yields: that is the point
    async *stream() {
      started();
      await new Promise<never>(() => {});
    },
  };
}

function run(provider: ChatProvider, signal: AbortSignal) {
  const events = { done: 0, errors: [] as string[] };
  const finished = runAgentLoop({
    provider,
    driver,
    task: "do it",
    signal,
    callbacks: {
      onDone: () => void events.done++,
      onError: (message) => void events.errors.push(message),
    },
  });
  return { events, finished };
}

afterEach(() => vi.useRealTimers());

describe("a model turn that never answers", () => {
  it("unwinds the moment Stop is pressed, even when nothing listens to the signal", async () => {
    const controller = new AbortController();
    let started = false;
    const { events, finished } = run(
      hungProvider(() => (started = true)),
      controller.signal,
    );
    await vi.waitFor(() => expect(started).toBe(true));

    controller.abort();
    await finished;

    expect(events.done).toBe(1);
    expect(events.errors).toEqual([]);
  });

  it("gives up after the stall deadline with a plain error, and does not replay the prompt", async () => {
    vi.useFakeTimers();
    let streams = 0;
    const { events, finished } = run(
      hungProvider(() => streams++),
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(streams).toBe(1);

    await vi.advanceTimersByTimeAsync(6 * 60_000);
    await finished;

    expect(streams).toBe(1);
    expect(events.errors).toHaveLength(1);
    expect(events.errors[0]).toContain("6 minutes");
  });
});
