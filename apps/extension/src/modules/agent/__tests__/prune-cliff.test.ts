import { describe, it, expect } from "vitest";
import { runAgentLoop } from "../loop";
import type { BrowserDriver } from "@/modules/browser";
import type { SnapshotResult } from "@/modules/browser/snapshot";
import type { ChatMessage, ChatProvider } from "@/modules/providers/types";

// Storage stand-in and i18n come from src/test-setup.ts (vitest setupFiles).

/** About what a real page's accessibility tree serializes to. */
const PAGE = "x".repeat(10_000);

// Tests: one-method stand-in — a run that only ever snapshots reaches nothing
// else on the driver (settle and the staleness census both need a page action).
const driver = {
  snapshot: async (): Promise<SnapshotResult> => ({
    pageContent: PAGE,
    viewport: { width: 800, height: 600 },
    url: "https://example.com",
    title: "Example",
    newRefs: 0,
  }),
} as unknown as BrowserDriver;

/**
 * Snapshots `turns` times, then finishes — recording each turn whether any
 * message that already existed last turn came back rewritten.
 *
 * That count is what a provider's cache actually sees: one changed byte
 * anywhere in the prefix and everything from there on re-bills at full price.
 */
function prefixWatcher(turns: number): { provider: ChatProvider; breaks: () => number } {
  let seen: string | null = null;
  let broken = 0;
  let turn = 0;
  return {
    breaks: () => broken,
    provider: {
      async *stream(messages) {
        if (seen !== null) {
          const prior = JSON.parse(seen) as ChatMessage[];
          if (JSON.stringify(messages.slice(0, prior.length)) !== seen) broken++;
        }
        seen = JSON.stringify(messages);
        turn++;
        yield turn > turns
          ? { type: "tool_use", id: `d${turn}`, name: "done", args: { summary: "ok" } }
          : { type: "tool_use", id: `c${turn}`, name: "snapshot", args: {} };
        yield { type: "done" };
      },
    },
  };
}

async function run(provider: ChatProvider): Promise<ChatMessage[]> {
  return runAgentLoop({
    provider,
    driver,
    task: "read the page over and over",
    signal: new AbortController().signal,
    callbacks: {},
  });
}

describe("keeping the prompt prefix cacheable", () => {
  it("trims in cliffs, so most turns leave the history untouched", async () => {
    // Twenty 10k snapshots against a 120k ceiling that cuts back to 60k. The
    // budget saturates around turn 12 and then refills over six turns, so it
    // trims twice in twenty. Shaving exactly enough to sit at the ceiling
    // instead rewrote the history on EVERY turn past saturation — nine of
    // these twenty — and each rewrite lands at the old end of the array, so it
    // invalidated nearly the entire cached request rather than its tail.
    const { provider, breaks } = prefixWatcher(20);
    await run(provider);
    expect(breaks()).toBeLessThanOrEqual(2);
  });

  it("still bounds the body — the cliff drops context, it does not keep it", async () => {
    // The cliff is a caching concession, not a retreat from the reason the
    // pruner exists: a long run must not grow its own request into a
    // context-length 400.
    const messages = await run(prefixWatcher(20).provider);
    const results = messages.flatMap((m) => m.toolResults ?? []);
    const kept = results.reduce((n, r) => n + r.content.length, 0);
    expect(results.some((r) => r.content.includes("trimmed"))).toBe(true);
    expect(kept).toBeLessThan(120_000);
  });
});
