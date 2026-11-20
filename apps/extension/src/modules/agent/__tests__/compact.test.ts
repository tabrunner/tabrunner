import { describe, it, expect, vi, beforeEach } from "vitest";
import { compactConversation } from "../compact";
import { runAgentLoop } from "../loop";
import { ProviderError } from "@/modules/providers/types";
import type { ChatProvider, Delta } from "@/modules/providers/types";
import type { BrowserDriver } from "@/modules/browser";
import type { SnapshotResult } from "@/modules/browser/snapshot";
import type { Message } from "@/modules/conversation/types";
import type * as conversation from "@/modules/conversation";

/**
 * The transcript store is mocked: compactConversation's contract is WHAT gets
 * folded and appended, not how storage persists it.
 */
let stored: Message[];
let appended: Message | null;
vi.mock("@/modules/conversation", async (importOriginal) => ({
  // The real module rides along for the pure parts (renderTranscriptMessage).
  ...(await importOriginal<typeof conversation>()),
  getMessages: vi.fn(async () => stored),
  appendMessageTo: vi.fn(async (_id: string, msg: Message) => {
    appended = msg;
    return msg.id;
  }),
}));

beforeEach(() => {
  appended = null;
});

const driver = {
  snapshot: async (): Promise<SnapshotResult> => ({
    pageContent: "Page with a button [ref=e1]",
    viewport: { width: 800, height: 600 },
    url: "https://example.com",
    title: "Example",
    newRefs: 0,
  }),
} as unknown as BrowserDriver;

describe("in-run SDK compaction (A4)", () => {
  it("reports onContextLimit, folds with task pin, and retries the same turn on context overflow", async () => {
    const contextLimits: number[] = [];
    const steps: { tool: string }[] = [];
    let rejectedOnce = false;
    let sawPinnedTaskAfterFold = false;
    let sawSummaryAfterFold = false;
    let normalTurns = 0;

    const provider: ChatProvider = {
      async *stream(messages): AsyncIterable<Delta> {
        const system = messages.find((m) => m.role === "system")?.content ?? "";
        // Compaction summary call uses COMPACT_SYSTEM instructions.
        if (system.includes("compacting the record of a browser-automation session")) {
          yield { type: "text", text: "1. Task: book a flight\n2. Findings: seat 4A held" };
          yield { type: "done" };
          return;
        }
        normalTurns++;
        if (normalTurns <= 2) {
          yield { type: "usage", input: 18_000, output: 100 };
          yield { type: "tool_use", id: `s${normalTurns}`, name: "snapshot", args: {} };
          yield { type: "done" };
          return;
        }
        if (normalTurns === 3 && !rejectedOnce) {
          rejectedOnce = true;
          throw new ProviderError("prompt is too long: 19500 > 16000", 400, "context");
        }
        // Retry after reactive compaction must preserve the pinned original task
        // and carry the generated summary.
        const userTexts = messages.filter((m) => m.role === "user").map((m) => m.content);
        sawPinnedTaskAfterFold = userTexts.some((t) => t.includes("book a flight"));
        sawSummaryAfterFold = userTexts.some((t) => t.includes("seat 4A held"));
        yield { type: "tool_use", id: "d1", name: "done", args: { summary: "Booked seat 4A" } };
        yield { type: "done" };
      },
    };

    let doneSummary: string | undefined;
    await runAgentLoop({
      provider,
      driver,
      task: "book a flight",
      contextWindow: 120_000,
      signal: new AbortController().signal,
      callbacks: {
        onContextLimit: (observed) => contextLimits.push(observed),
        onStep: (s) => steps.push(s),
        onDone: (s) => (doneSummary = s),
      },
    });

    expect(rejectedOnce).toBe(true);
    expect(contextLimits.length).toBe(1);
    expect(sawPinnedTaskAfterFold).toBe(true);
    expect(sawSummaryAfterFold).toBe(true);
    expect(steps.some((s) => s.tool === "compact")).toBe(true);
    expect(doneSummary).toBe("Booked seat 4A");
  });
});

let seq = 0;
function transcriptMsg(role: Message["role"], content: string): Message {
  seq += 1;
  return { id: `t${seq}`, role, content, timestamp: seq };
}

describe("compactConversation", () => {
  it("folds everything since the last summary — the recent exchange included", async () => {
    // A tail kept raw would sit ABOVE the appended summary, and replay starts
    // at the summary — so a "kept" tail would reach neither the summarizer nor
    // the model. The fold must run to the end of the transcript.
    stored = [
      transcriptMsg("user", "find me a flight"),
      transcriptMsg("assistant", "checked Kayak"),
      transcriptMsg("user", "book it"),
      transcriptMsg("assistant", "booked, seat 4A"),
    ];
    let seen = "";
    const provider: ChatProvider = {
      async *stream(messages): AsyncIterable<Delta> {
        seen = messages.map((m) => m.content).join("");
        yield { type: "text", text: "1. Task: flight. 2. Findings: seat 4A." };
        yield { type: "done" };
      },
    };

    const result = await compactConversation(provider, "c1", new AbortController().signal);

    expect(seen).toContain("seat 4A"); // the last exchange reached the summarizer
    expect(result?.messages).toBe(4);
    expect(appended?.role).toBe("summary");
    expect(appended?.compacted?.messages).toBe(4);
    expect(appended?.compacted?.before).toBeGreaterThan(0);
  });

  it("feeds the previous summary into the new one, superseding it", async () => {
    stored = [
      transcriptMsg("user", "old task"),
      transcriptMsg("assistant", "old outcome"),
      transcriptMsg("summary", "1. Task: old. 2. Findings: price was $42."),
      transcriptMsg("user", "new task"),
      transcriptMsg("assistant", "did the new thing"),
      transcriptMsg("user", "and another"),
      transcriptMsg("assistant", "done too"),
    ];
    let seen = "";
    const provider: ChatProvider = {
      async *stream(messages): AsyncIterable<Delta> {
        seen = messages.map((m) => m.content).join("");
        yield { type: "text", text: "fresh summary" };
        yield { type: "done" };
      },
    };

    const result = await compactConversation(provider, "c1", new AbortController().signal);

    // The old summary plus everything after it — nothing before it is refolded.
    expect(result?.messages).toBe(5);
    expect(seen).toContain("$42");
    expect(seen).not.toContain("old task");
  });

  it("declines a conversation too short to be worth a model call", async () => {
    stored = [transcriptMsg("user", "hi"), transcriptMsg("assistant", "hello")];
    let called = false;
    const provider: ChatProvider = {
      async *stream(): AsyncIterable<Delta> {
        called = true;
        yield { type: "done" };
      },
    };

    expect(await compactConversation(provider, "c1", new AbortController().signal)).toBeNull();
    expect(called).toBe(false);
    expect(appended).toBeNull();
  });
});
