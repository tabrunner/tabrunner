import { describe, it, expect } from "vitest";
import { MAX_MESSAGES, RECENT_WINDOW, pruneTranscript } from "../conversations";
import type { Message } from "../types";

/**
 * The two-tier cap. A flat cap spent itself on step and reasoning rows — one
 * run writes dozens — so a conversation lost the turns it was made of after a
 * handful of exchanges. Past the recent window only the spine survives, which
 * is what lets scrollback (and `read_history`) reach an order of magnitude
 * further back at no more weight.
 */
let seq = 0;
function m(role: Message["role"], extra?: Partial<Message>): Message {
  seq += 1;
  return { id: `m${seq}`, role, content: `c${seq}`, timestamp: seq, ...extra };
}

/** Enough noise to push whatever precedes it clear of the recent window. */
function noise(n: number): Message[] {
  return Array.from({ length: n }, () => m("step", { tool: "click" }));
}

describe("pruneTranscript", () => {
  it("leaves a transcript shorter than the window exactly as it is", () => {
    const list = [m("user"), m("step", { tool: "click" }), m("reasoning")];
    expect(pruneTranscript(list)).toBe(list);
  });

  it("keeps every role inside the recent window — that is the crash record", () => {
    const recent = [m("reasoning"), m("step", { tool: "click" }), m("assistant")];
    const list = [...noise(RECENT_WINDOW), ...recent];

    const kept = pruneTranscript(list).slice(-3);
    expect(kept.map((x) => x.id)).toEqual(recent.map((x) => x.id));
  });

  it("drops old step and reasoning rows but keeps the conversation around them", () => {
    const turn = m("user");
    const plan = m("plan", { steps: ["one"] });
    const thought = m("reasoning");
    const click = m("step", { tool: "click" });
    const answer = m("assistant");
    const list = [turn, plan, thought, click, answer, ...noise(RECENT_WINDOW)];

    const ids = pruneTranscript(list).map((x) => x.id);
    expect(ids).toContain(turn.id);
    expect(ids).toContain(plan.id);
    expect(ids).toContain(answer.id);
    expect(ids).not.toContain(thought.id);
    expect(ids).not.toContain(click.id);
    // Order is the transcript's meaning — pruning must not reshuffle it.
    expect(ids.indexOf(turn.id)).toBeLessThan(ids.indexOf(plan.id));
    expect(ids.indexOf(plan.id)).toBeLessThan(ids.indexOf(answer.id));
  });

  it("keeps an old ask_user step — the answer below it replies to that question", () => {
    const asked = m("step", { tool: "ask_user" });
    const list = [asked, m("user"), ...noise(RECENT_WINDOW)];

    expect(pruneTranscript(list).map((x) => x.id)).toContain(asked.id);
  });

  it("holds the ceiling, dropping the oldest spine first", () => {
    const spine = Array.from({ length: MAX_MESSAGES + 50 }, () => m("assistant"));
    const pruned = pruneTranscript(spine);

    expect(pruned).toHaveLength(MAX_MESSAGES);
    expect(pruned[0]?.id).toBe(spine[50]?.id);
    expect(pruned.at(-1)?.id).toBe(spine.at(-1)?.id);
  });
});
