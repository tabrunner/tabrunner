import { describe, it, expect } from "vitest";
import { buildConversationHistory } from "../history";
import type { Message } from "@/modules/conversation/types";

let seq = 0;
function msg(role: Message["role"], content: string): Message {
  seq += 1;
  return { id: `m${seq}`, role, content, timestamp: seq };
}

describe("buildConversationHistory", () => {
  it("replays user and assistant turns, skipping steps, plans and reasoning", () => {
    const history = buildConversationHistory([
      msg("user", "find me an available domain name"),
      msg("step", "Navigated successfully"),
      msg("plan", ""),
      msg("reasoning", "hmm"),
      msg("assistant", "Tried “zephyra” — taken. Trying “quorix”."),
      msg("user", "continue"),
    ]);

    expect(history).toEqual([
      { role: "user", content: "find me an available domain name" },
      { role: "assistant", content: "Tried “zephyra” — taken. Trying “quorix”." },
    ]);
  });

  it("ends before the current task — the loop builds that message itself", () => {
    const history = buildConversationHistory([
      msg("user", "first task"),
      msg("assistant", "done"),
      msg("user", "second task"),
    ]);
    expect(history.map((m) => m.content)).toEqual(["first task", "done"]);
  });

  it("merges consecutive same-role bubbles so the wire alternates", () => {
    const history = buildConversationHistory([
      msg("user", "first task"),
      msg("assistant", "mid-run note"),
      msg("assistant", "final summary"),
      msg("user", "next"),
    ]);

    expect(history).toHaveLength(2);
    expect(history[1]?.content).toBe("mid-run note\n\nfinal summary");
  });

  it("replays ask_user questions as assistant turns, keeping the Q&A pair", () => {
    const history = buildConversationHistory([
      msg("user", "find me a domain"),
      { ...msg("step", "Should I buy velthari.com with the saved Mastercard?"), tool: "ask_user" },
      msg("user", "yes, do it"),
      msg("assistant", "bought it"),
      msg("user", "next"),
    ]);

    expect(history.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(history[1]?.content).toContain("velthari.com");
  });

  it("keeps mid-run corrections in order", () => {
    const history = buildConversationHistory([
      msg("user", "buy the blue one"),
      msg("user", "no wait, the green one"),
      msg("assistant", "bought the green one"),
      msg("user", "thanks"),
    ]);

    // Back-to-back user notes merge into one turn; nothing is lost.
    expect(history[0]?.content).toBe("buy the blue one\n\nno wait, the green one");
    expect(history[1]?.content).toBe("bought the green one");
  });

  it("on overflow keeps the original task plus the newest exchanges", () => {
    const transcript: Message[] = [];
    for (let i = 1; i <= 60; i++) {
      // 1k each — 120k total, far past the budget.
      transcript.push(
        msg("user", `task ${i} `.padEnd(1000, ".")),
        msg("assistant", `outcome ${i} `.padEnd(1000, ".")),
      );
    }
    // A run-start transcript always ends on the fresh task.
    transcript.push(msg("user", "current task"));
    // The budget now scales with the model's window, so the window is named
    // here rather than assumed — 32k lands on the 24k floor.
    const history = buildConversationHistory(transcript, 32_000);

    const chars = history.reduce((n, m) => n + m.content.length, 0);
    expect(chars).toBeLessThanOrEqual(24_000);
    expect(history[0]?.content).toContain("task 1");
    expect(history.at(-1)?.content).toContain("outcome 60");
    // Still strictly alternating.
    history.forEach((m, i) => {
      const prev = history[i - 1];
      if (prev) expect(m.role).not.toBe(prev.role);
    });
  });

  it("keeps a long answer whole — the next message refers to it", () => {
    // The regression: a 28-name list truncated mid-way made "search those"
    // search half a list.
    const list = Array.from({ length: 28 }, (_, i) => `${i + 1}. name${i + 1}`).join("\n");
    const history = buildConversationHistory([
      msg("user", "propose names"),
      msg("assistant", list),
      msg("user", "search them"),
    ]);

    expect(history[1]?.content).toContain("28. name28");
  });

  it("strips image tokens and caps a single runaway entry", () => {
    const history = buildConversationHistory([
      msg("user", `look at this ${"[Image #1]"} and ${"x".repeat(9000)}`),
      msg("assistant", "ok"),
      msg("user", "next"),
    ]);

    expect(history[0]?.content).not.toContain("[Image #1]");
    expect(history[0]!.content.length).toBeLessThanOrEqual(4_001);
  });

  it("returns nothing for a fresh conversation", () => {
    expect(buildConversationHistory([])).toEqual([]);
    expect(buildConversationHistory([msg("user", "only the current task")])).toEqual([]);
  });
});

describe("buildConversationHistory after a compaction", () => {
  it("replays from the newest summary instead of sending the same history twice", () => {
    const history = buildConversationHistory([
      msg("user", "find me a flight"),
      msg("assistant", "checked Kayak"),
      msg("summary", "1. Task: find a flight. 2. Findings: BA117 at 09:00."),
      msg("user", "book it"),
      msg("assistant", "booked, seat 4A"),
      msg("user", "now add a hotel"),
    ]);

    // The summary leads, in the agent's own voice, and the pre-compaction
    // exchange it stands for is gone from the replay.
    expect(history[0]).toEqual({
      role: "assistant",
      content: "1. Task: find a flight. 2. Findings: BA117 at 09:00.",
    });
    expect(JSON.stringify(history)).not.toContain("checked Kayak");
    expect(JSON.stringify(history)).toContain("book it");
  });

  it("ignores a summary that lands after the last user message", () => {
    // A run ends, writes its summary, and the user has not replied yet. Replay
    // must still carry the exchange above it — starting at that summary would
    // drop the very message the pending run is about.
    const history = buildConversationHistory([
      msg("user", "find me a flight"),
      msg("assistant", "found BA117"),
      msg("user", "book it"),
      msg("summary", "a summary of everything"),
    ]);
    expect(history).toEqual([
      { role: "user", content: "find me a flight" },
      { role: "assistant", content: "found BA117" },
    ]);
  });

  it("scales the replay budget to the model's window", () => {
    const transcript: Message[] = [];
    // Entries are capped at 4k each, so depth is what the budget buys — 40
    // exchanges is ~120k chars, past the small window and inside the large one.
    for (let i = 1; i <= 40; i++) {
      transcript.push(
        msg("user", `ask ${i} `.padEnd(1500, ".")),
        msg("assistant", `answer ${i} `.padEnd(1500, ".")),
      );
    }
    transcript.push(msg("user", "continue"));

    const small = buildConversationHistory(transcript, 32_000);
    const large = buildConversationHistory(transcript, 400_000);
    const chars = (h: typeof small) => h.reduce((n, m) => n + m.content.length, 0);

    expect(chars(small)).toBeLessThanOrEqual(24_000);
    expect(chars(large)).toBeGreaterThan(chars(small));
    // Both keep the original task, whatever else they drop.
    expect(small[0]?.content).toContain("ask 1");
    expect(large[0]?.content).toContain("ask 1");
  });
});
