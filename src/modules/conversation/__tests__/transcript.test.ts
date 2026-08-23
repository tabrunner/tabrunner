import { describe, it, expect } from "vitest";

import { TranscriptWriter } from "../transcript";
import { getMessages } from "../conversations";
import type { Event } from "@/shared/protocol";

/**
 * The writer appends fire-and-forget through the serialized storage chain, and
 * the in-memory storage stub settles entirely in microtasks — so one macrotask
 * turn is enough for every queued write to have landed.
 */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

async function replay(id: string, events: Event[]) {
  const writer = new TranscriptWriter(id);
  events.forEach((e) => writer.apply(e));
  await settled();
  return (await getMessages(id)).map((m) => [m.role, m.content] as const);
}

describe("TranscriptWriter", () => {
  it("writes a run the way the panel renders it: thoughts, tools, prose, close", async () => {
    const rows = await replay("run-1", [
      { type: "reasoning", text: "inbox first" },
      // Prose closes the reasoning segment — a run reads in the order it happened.
      { type: "token", text: "Opening the inbox" },
      { type: "step_start", tool: "navigate" },
      { type: "step", tool: "navigate", summary: "Navigated successfully", ok: true },
      { type: "usage", input: 10, output: 4 },
      { type: "done", summary: "Two unread invoices." },
    ]);

    expect(rows).toEqual([
      ["reasoning", "inbox first"],
      // A tool call closes the prose segment too, so what the model said before
      // acting stays above the row for the act. See interleave.test.ts.
      ["assistant", "Opening the inbox"],
      ["step", "Navigated successfully"],
      ["assistant", "Two unread invoices."],
    ]);
  });

  it("rewrites the plan card in place instead of stacking copies", async () => {
    const writer = new TranscriptWriter("run-2");
    writer.apply({ type: "plan", steps: ["open", "read"], current: 0 });
    writer.apply({ type: "plan", steps: ["open", "read"], current: 1 });
    await settled();

    const stored = await getMessages("run-2");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ role: "plan", current: 1 });
  });

  it("flushes a partial stream before the error, so no prose is lost", async () => {
    const rows = await replay("run-3", [
      { type: "token", text: "Checking the cart" },
      { type: "error", message: "Provider error: 429" },
    ]);

    expect(rows).toEqual([
      ["assistant", "Checking the cart"],
      ["error", "Provider error: 429"],
    ]);
  });

  it("keeps the classified kind on the stored error message", async () => {
    const writer = new TranscriptWriter("run-kind");
    writer.apply({ type: "error", message: "Provider error: 429", kind: "rate" });
    await settled();

    const stored = await getMessages("run-kind");
    expect(stored[0]).toMatchObject({ role: "error", kind: "rate" });
  });

  it("leaves a progress note when a run dies after doing work", async () => {
    const rows = await replay("run-err", [
      {
        type: "step",
        tool: "navigate",
        summary: "Navigated successfully",
        ok: true,
        args: { url: "https://www.reddit.com/r/all" },
      },
      { type: "step", tool: "snapshot", summary: "Captured 154 elements", ok: true },
      { type: "error", message: "Provider error: 429" },
    ]);

    expect(rows[0]).toEqual(["step", "Navigated successfully"]);
    expect(rows[1]).toEqual(["step", "Captured 154 elements"]);
    // The note replays into the next run's history — the error message never does.
    expect(rows[2]?.[0]).toBe("assistant");
    expect(rows[2]?.[1]).toContain("reddit.com");
    expect(rows[2]?.[1]).toContain("Provider error: 429");
    expect(rows[3]).toEqual(["error", "Provider error: 429"]);
  });

  it("writes no progress note when the run died before its first step", async () => {
    const rows = await replay("run-err-early", [{ type: "error", message: "Provider error: 429" }]);
    expect(rows).toEqual([["error", "Provider error: 429"]]);
  });

  it("keeps retry chatter out of the progress note", async () => {
    const rows = await replay("run-err-retry", [
      { type: "step", tool: "retry", summary: "Connection hiccup — retrying (1/2)" },
      { type: "step", tool: "snapshot", summary: "Captured 154 elements", ok: true },
      { type: "error", message: "Provider error: 429" },
    ]);

    const note = rows.find(([role]) => role === "assistant");
    expect(note?.[1]).toContain("Captured 154 elements");
    expect(note?.[1]).not.toContain("retrying");
  });

  it("leaves a progress note when the user stops a run mid-work", async () => {
    const rows = await replay("run-stop", [
      { type: "step", tool: "snapshot", summary: "Captured 154 elements", ok: true },
      // A stop unwinds the loop as a summary-less done.
      { type: "done", stopped: true },
    ]);

    // What the user sees: their halt, marked. What the model gets: the note.
    expect(rows[0]).toEqual(["step", "Captured 154 elements"]);
    expect(rows[1]).toEqual([
      "step",
      "You stopped this task — your next message can pick up from here.",
    ]);
    expect(rows[2]?.[0]).toBe("assistant");
    expect(rows[2]?.[1]).toContain("The user stopped this run");
    expect(rows[2]?.[1]).toContain("Captured 154 elements");
  });

  it("keeps the progress note out of the chat and in the history", async () => {
    const writer = new TranscriptWriter("run-internal");
    writer.apply({ type: "step", tool: "snapshot", summary: "Captured 154 elements", ok: true });
    writer.apply({ type: "done", stopped: true });
    await settled();

    const stored = await getMessages("run-internal");
    const note = stored.find((m) => m.role === "assistant");
    // Written for the model, so it replays as an assistant turn — and is never drawn.
    expect(note?.internal).toBe(true);
    expect(stored.filter((m) => m.internal).length).toBe(1);
  });

  it("never blames the user for a run a dead tab aborted", async () => {
    const rows = await replay("run-tab-abort", [
      { type: "step", tool: "snapshot", summary: "Captured 154 elements", ok: true },
      { type: "error", message: "The tab “Cart” was closed" },
      // The abort that error triggered unwinds as a done — aborted, not stopped.
      { type: "done", stopped: true },
    ]);

    expect(rows.map(([, content]) => content).join("\n")).not.toContain("You stopped this run");
  });

  it("writes no note for a run that ended on a question — the card is its closing word", async () => {
    const rows = await replay("run-ask", [
      { type: "step", tool: "ask_user", summary: "Which invoice?" },
      { type: "done", question: true },
    ]);

    expect(rows).toEqual([["step", "Which invoice?"]]);
  });

  it("writes one note, not two, when the error that ends the run also aborts it", async () => {
    const rows = await replay("run-tab-gone", [
      { type: "step", tool: "snapshot", summary: "Captured 154 elements", ok: true },
      { type: "error", message: "The tab “Cart” was closed" },
      // The abort that error triggered unwinds the loop right behind it.
      { type: "done" },
    ]);

    expect(rows.filter(([role]) => role === "assistant")).toHaveLength(1);
    expect(rows[1]?.[1]).toContain("The tab “Cart” was closed");
  });

  it("drops a done summary that only repeats the prose already shown", async () => {
    const rows = await replay("run-4", [
      { type: "token", text: "The invoice is paid." },
      { type: "done", summary: "The invoice is paid" },
    ]);

    expect(rows).toEqual([["assistant", "The invoice is paid."]]);
  });

  it("keeps each run in its own conversation", async () => {
    await replay("thread-a", [{ type: "done", summary: "a" }]);
    await replay("thread-b", [{ type: "done", summary: "b" }]);

    expect((await getMessages("thread-a")).map((m) => m.content)).toEqual(["a"]);
    expect((await getMessages("thread-b")).map((m) => m.content)).toEqual(["b"]);
  });
});
