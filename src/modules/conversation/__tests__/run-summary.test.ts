import { describe, it, expect } from "vitest";

import { TranscriptWriter } from "../transcript";
import { appendMessageTo, listConversations, noteContextFreed } from "../conversations";
import type { Event } from "@/shared/protocol";
import type { Message } from "../types";

/**
 * Same settle trick as transcript.test.ts: the writer records fire-and-forget
 * through the serialized storage chain, and the in-memory storage stub settles
 * in microtasks — one macrotask turn drains every queued write.
 */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

async function replay(id: string, events: Event[]) {
  const writer = new TranscriptWriter(id);
  events.forEach((e) => writer.apply(e));
  await settled();
}

const rowOf = async (id: string) => (await listConversations()).find((c) => c.id === id);
const lastRunOf = async (id: string) => (await rowOf(id))?.lastRun;

describe("last-run summary", () => {
  it("stamps the conversation with the run's span and tokens when it ends", async () => {
    await replay("run-sum", [
      // Running totals, as start-run emits them — the second turn's own input
      // was 5, which is what `contextTokens` carries.
      { type: "usage", input: 10, output: 4, contextTokens: 10 },
      { type: "usage", input: 15, output: 6, contextTokens: 5 },
      { type: "done", summary: "All set." },
    ]);

    const lastRun = await lastRunOf("run-sum");
    if (!lastRun) throw new Error("summary not recorded");
    expect(lastRun).toMatchObject({ input: 15, output: 6 });
    expect(lastRun.endedAt).toBeGreaterThanOrEqual(lastRun.startedAt);
    // The LAST turn's input, not the sum — it is the one that says how full the
    // context actually was, and the gauge shows it after a panel reopen. It
    // rides the CONVERSATION, not the summary: the next user message retires
    // the summary, and the context it describes is still there.
    expect((await rowOf("run-sum"))?.contextTokens).toBe(5);
  });

  it("stamps an error end too — the band settles the same either way", async () => {
    await replay("run-err-sum", [{ type: "error", message: "Provider error: 429" }]);
    expect(await lastRunOf("run-err-sum")).toBeDefined();
  });

  it("stamps a run that ended on a question — the band says waiting, not done", async () => {
    await replay("run-q-sum", [
      { type: "step", tool: "ask_user", summary: "Which invoice?" },
      { type: "done", question: true },
    ]);
    expect(await lastRunOf("run-q-sum")).toBeDefined();
  });

  it("is retired by the next user message", async () => {
    await replay("run-clear", [{ type: "done", summary: "Done." }]);
    expect(await lastRunOf("run-clear")).toBeDefined();

    await appendMessageTo("run-clear", {
      id: crypto.randomUUID(),
      role: "user",
      content: "and now something else",
      timestamp: Date.now(),
    });
    expect(await lastRunOf("run-clear")).toBeUndefined();
  });

  it("keeps the context reading when it retires the summary — the window did not empty", async () => {
    await replay("run-ctx", [
      { type: "usage", input: 12, output: 3, contextTokens: 12 },
      { type: "done", summary: "Done." },
    ]);
    await appendMessageTo("run-ctx", {
      id: crypto.randomUUID(),
      role: "user",
      content: "next thing",
      timestamp: Date.now(),
    });

    expect(await lastRunOf("run-ctx")).toBeUndefined();
    // Otherwise the gauge blanks the instant you press send and comes back a
    // minute later with the number it already had.
    expect((await rowOf("run-ctx"))?.contextTokens).toBe(12);
  });

  it("survives run-internal appends — only a fresh task retires it", async () => {
    await replay("run-keep", [{ type: "done", summary: "Done." }]);
    const breadcrumb: Message = {
      id: crypto.randomUUID(),
      role: "step",
      tool: "interrupted",
      content: "The run was cancelled",
      timestamp: Date.now(),
    };
    await appendMessageTo("run-keep", breadcrumb);
    expect(await lastRunOf("run-keep")).toBeDefined();
  });
});

describe("the context reading a fold moves", () => {
  it("comes down by what the fold freed — the gauge stops describing a request nobody will send", async () => {
    await replay("fold-move", [
      { type: "usage", input: 20_000, output: 100, contextTokens: 20_000 },
      { type: "done", summary: "Done." },
    ]);

    // 18.4k of replayed history became a 1.2k summary. The rest of the reading
    // — system prompt, tools, page snapshot — did not move, and neither does it.
    await noteContextFreed("fold-move", 18_400 - 1_200);

    expect((await rowOf("fold-move"))?.contextTokens).toBe(2_800);
  });

  it("leaves an unmeasured thread alone — a number nobody took cannot be corrected", async () => {
    await appendMessageTo("fold-unmeasured", {
      id: crypto.randomUUID(),
      role: "user",
      content: "hello",
      timestamp: Date.now(),
    });

    await noteContextFreed("fold-unmeasured", 5_000);

    // Not 0, which would draw a gauge claiming an empty window: the next run
    // measures fresh, and until it does the gauge says nothing.
    expect((await rowOf("fold-unmeasured"))?.contextTokens).toBeUndefined();
  });
});
