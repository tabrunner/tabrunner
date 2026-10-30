import { describe, it, expect, vi, beforeEach } from "vitest";
import { compactConversation, compactRunMessages } from "../compact";
import type { ChatMessage, ChatProvider, Delta } from "@/modules/providers/types";
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

/** A provider that answers every call with one fixed summary. */
function fakeProvider(summary = "1. Task: book a flight\n2. Findings: seat 4A held"): ChatProvider {
  return {
    async *stream(): AsyncIterable<Delta> {
      yield { type: "text", text: summary };
      yield { type: "done" };
    },
  };
}

/** A run's wire conversation: system, task, then N assistant/tool_results pairs. */
function runMessages(pairs: number): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "book a flight" },
  ];
  for (let i = 0; i < pairs; i++) {
    messages.push({
      role: "assistant",
      content: `turn ${i}`,
      toolCalls: [{ id: `c${i}`, name: "click", args: {} }],
    });
    messages.push({
      role: "tool_results",
      content: "",
      toolResults: [{ id: `c${i}`, content: `result ${i}` }],
    });
  }
  return messages;
}

describe("compactRunMessages", () => {
  it("folds the middle into the task and keeps the wire alternating", async () => {
    const messages = runMessages(10);
    const removed = await compactRunMessages(
      fakeProvider(),
      messages,
      1,
      "book a flight",
      new AbortController().signal,
    );

    expect(removed).toBeGreaterThan(0);
    expect(messages.length).toBe(22 - removed);
    // The summary rides on the task message — never as a turn of its own, which
    // would put two same-role turns back to back and 400 on Anthropic.
    expect(messages[1]?.role).toBe("user");
    expect(messages[1]?.content).toContain("book a flight");
    expect(messages[1]?.content).toContain("seat 4A held");
    // What survives the fold must start on an assistant turn: a tool_results
    // block whose assistant was folded away orphans its tool_use id.
    expect(messages[2]?.role).toBe("assistant");
  });

  it("never splits a tool call from its result", async () => {
    const messages = runMessages(12);
    await compactRunMessages(
      fakeProvider(),
      messages,
      1,
      "book a flight",
      new AbortController().signal,
    );

    const open = new Set<string>();
    for (const m of messages) {
      for (const call of m.toolCalls ?? []) open.add(call.id);
      for (const result of m.toolResults ?? []) {
        expect(open.has(result.id)).toBe(true);
        open.delete(result.id);
      }
    }
    expect([...open]).toEqual([]);
  });

  it("rebuilds the note from the original task, so a second pass never nests summaries", async () => {
    const messages = runMessages(10);
    const signal = new AbortController().signal;
    await compactRunMessages(fakeProvider("first summary"), messages, 1, "book a flight", signal);
    for (let i = 0; i < 8; i++) {
      messages.push({ role: "assistant", content: "more", toolCalls: [] });
      messages.push({ role: "tool_results", content: "", toolResults: [] });
    }
    await compactRunMessages(fakeProvider("second summary"), messages, 1, "book a flight", signal);

    const task = messages[1]?.content ?? "";
    expect(task).toContain("second summary");
    expect(task).not.toContain("first summary");
    // One note, not a stack of them.
    expect(task.match(/<progress_so_far>/g)?.length).toBe(1);
  });

  it("does nothing when there is no whole turn to fold", async () => {
    const messages = runMessages(2);
    const removed = await compactRunMessages(
      fakeProvider(),
      messages,
      1,
      "book a flight",
      new AbortController().signal,
    );
    expect(removed).toBe(0);
    expect(messages.length).toBe(6);
  });
});

describe("summarizer input bounds", () => {
  it("trims its own input, so compaction never fails for the reason it was called", async () => {
    let seen = "";
    const provider: ChatProvider = {
      async *stream(messages): AsyncIterable<Delta> {
        seen = messages.map((m) => m.content).join("");
        yield { type: "text", text: "summary" };
        yield { type: "done" };
      },
    };

    // Each result is already truncated per-entry when rendered, so the size
    // that defeats a summarizer is MANY turns, not one huge one — a long run
    // of page snapshots, which is exactly what overflows a window.
    const messages = runMessages(40);
    for (const m of messages) {
      for (const result of m.toolResults ?? []) result.content = "x".repeat(20_000);
    }
    await compactRunMessages(provider, messages, 1, "task", new AbortController().signal);

    expect(seen.length).toBeLessThan(100_000);
    expect(seen).toContain("earlier turns omitted");
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
