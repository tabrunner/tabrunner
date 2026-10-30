import { describe, it, expect } from "vitest";
import { runAgentLoop } from "../loop";
import { i18n } from "@/i18n";
import type { BrowserDriver } from "@/modules/browser";
import type { SnapshotResult } from "@/modules/browser/snapshot";
import type { ChatMessage, ChatProvider, ToolCall } from "@/modules/providers/types";

// Storage stand-in and i18n come from src/test-setup.ts (vitest setupFiles).
//
// A turn's tool calls are a batch: the model writes them all against one page
// state, so the loop stops the batch at whatever invalidates the rest of it.
// These cover what stops it, what doesn't, and that no call ever goes unanswered.

interface DriverOpts {
  /** Tools whose driver call throws. */
  failing?: string[];
  /** What `settle` reports — a load started after the action, or the page stayed put. */
  navigated?: boolean;
  /** Refs each walk mints — how a stand-in page says something new appeared. */
  newRefs?: number;
}

/** Driver stand-in — records every attempt in `calls`, including `settle`. */
function makeDriver(calls: string[] = [], opts: DriverOpts = {}): BrowserDriver {
  const attempt = <T>(name: string, value: T) => {
    calls.push(name);
    if (opts.failing?.includes(name)) throw new Error(`${name} boom`);
    return value;
  };
  return {
    snapshot: async (): Promise<SnapshotResult> =>
      attempt("snapshot", {
        pageContent: "Page with a button [ref=e1]",
        viewport: { width: 800, height: 600 },
        url: "https://example.com",
        title: "Example",
        newRefs: opts.newRefs ?? 0,
      }),
    find: async (query: string) =>
      attempt("find", { query, url: "https://example.com", matches: [], total: 0 }),
    click: async () => attempt("click", { x: 1, y: 2 }),
    fill: async () => attempt("fill", undefined),
    navigate: async () => attempt("navigate", undefined),
    scrollDown: async () => attempt("scroll_down", undefined),
    listTabs: async () => attempt("list_tabs", []),
    settle: async () => attempt("settle", opts.navigated === true),
  } as unknown as BrowserDriver;
}

/** Streams one scripted turn's calls per step, then done. */
function scriptedProvider(script: ToolCall[][]): ChatProvider {
  let turn = 0;
  return {
    async *stream() {
      const calls = script[turn++] ?? [{ id: "done", name: "done", args: { summary: "ok" } }];
      for (const call of calls) yield { type: "tool_use", ...call };
      yield { type: "done" };
    },
  };
}

/** Ids are per-call, not per-tool: one turn routinely holds two clicks. */
let seq = 0;
const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({
  id: `c${++seq}-${name}`,
  name,
  args,
});

const plan = (steps: string[]) => call("plan", { steps, current: 0 });

/** Every tool_result the run produced, in order. */
const allResults = (wire: ChatMessage[]) =>
  wire.filter((m) => m.role === "tool_results").flatMap((m) => m.toolResults ?? []);

const run = (provider: ChatProvider, driver: BrowserDriver, extra = {}) =>
  runAgentLoop({
    provider,
    driver,
    task: "do the thing",
    signal: new AbortController().signal,
    callbacks: { onPlanApproval: async () => ({ approved: true }) },
    ...extra,
  });

describe("a turn's calls are a batch", () => {
  it("stops the batch at a failed action, and answers every call behind it", async () => {
    const calls: string[] = [];
    const first = call("click", { ref: "e1" });
    const second = call("click", { ref: "e2" });
    const third = call("snapshot");
    const wire = await run(
      scriptedProvider([[plan(["Click both"])], [first, second, third]]),
      makeDriver(calls, { failing: ["click"] }),
    );

    // One attempt, not three: the calls behind the failure were written for the
    // page it was supposed to produce.
    expect(calls.filter((c) => c === "click")).toEqual(["click"]);
    const results = allResults(wire);
    // Every tool_use id still gets a result — the wire wants one, and the text
    // is what tells the model apart "this failed" from "this never ran".
    for (const c of [first, second, third]) {
      expect(results.some((r) => r.id === c.id)).toBe(true);
    }
    expect(results.find((r) => r.id === first.id)?.content).toContain("click boom");
    expect(results.find((r) => r.id === second.id)?.content).toContain("did not run");
    expect(results.find((r) => r.id === third.id)?.content).toContain("did not run");
  });

  it("does not stop the batch at a failed read", async () => {
    const calls: string[] = [];
    // Batched reads are independent by construction — one missing its target
    // says nothing about the click that follows it.
    await run(
      scriptedProvider([
        [plan(["Click it"])],
        [call("find", { query: "x" }), call("click", { ref: "e1" })],
      ]),
      makeDriver(calls, { failing: ["find"] }),
    );

    expect(calls).toContain("click");
  });

  it("leaves the rest of the batch alone when the plan gate bounces an action", async () => {
    const calls: string[] = [];
    const blocked = call("click", { ref: "e1" });
    const read = call("snapshot");
    // No plan yet: the click is held back, but looking was never gated.
    const wire = await run(scriptedProvider([[blocked, read]]), makeDriver(calls));

    const results = allResults(wire);
    expect(results.find((r) => r.id === blocked.id)?.content).toContain(
      i18n.t("errors.planGateModel"),
    );
    expect(results.find((r) => r.id === read.id)?.content).toContain("Page with a button");
    expect(calls).not.toContain("click");
  });

  it("does not run what a closing `done` was batched in front of", async () => {
    const calls: string[] = [];
    const summaries: (string | undefined)[] = [];
    // The run returns the moment this turn drains, so a trailing action would
    // act on a run nobody is left watching.
    await run(
      scriptedProvider([
        [plan(["Wrap up"])],
        [call("done", { summary: "all set" }), call("click", { ref: "e1" })],
      ]),
      makeDriver(calls),
      {
        callbacks: {
          onPlanApproval: async () => ({ approved: true }),
          onDone: (s?: string) => summaries.push(s),
        },
      },
    );

    expect(summaries).toEqual(["all set"]);
    expect(calls).not.toContain("click");
  });

  it("does not run what an `ask_user` was batched in front of", async () => {
    const calls: string[] = [];
    const questions: string[] = [];
    await run(
      scriptedProvider([
        [plan(["Ask first"])],
        [call("ask_user", { question: "Which one?" }), call("click", { ref: "e1" })],
      ]),
      makeDriver(calls),
      {
        callbacks: {
          onPlanApproval: async () => ({ approved: true }),
          onAskUser: (q: string) => questions.push(q),
        },
      },
    );

    expect(questions).toEqual(["Which one?"]);
    expect(calls).not.toContain("click");
  });

  it("keeps a cancelled call off the step log — it never ran", async () => {
    const steps: { tool: string; ok?: boolean }[] = [];
    const started: string[] = [];
    await run(
      scriptedProvider([
        [plan(["Click both"])],
        [call("click", { ref: "e1" }), call("click", { ref: "e2" })],
      ]),
      makeDriver([], { failing: ["click"] }),
      {
        callbacks: {
          onPlanApproval: async () => ({ approved: true }),
          onStep: (s: { tool: string; ok?: boolean }) => steps.push(s),
          onStepStart: (tool: string) => started.push(tool),
        },
      },
    );

    // The failed click's red ✗ is the whole story: a second row for a call that
    // never happened would read as a second attempt.
    expect(started.filter((t) => t === "click")).toHaveLength(1);
    expect(steps.filter((s) => s.tool === "click")).toHaveLength(1);
    expect(steps.find((s) => s.tool === "click")?.ok).toBe(false);
  });
});

/** Just the driver's actions — the opening snapshot and the censuses are noise here. */
const acted = (calls: string[]) => calls.filter((c) => c !== "snapshot");
/** Walks beyond the run's opening one: every census the loop ran. */
const censuses = (calls: string[]) => calls.filter((c) => c === "snapshot").length - 1;

describe("settling between a turn's calls", () => {
  it("settles between calls, and not after the last one", async () => {
    const calls: string[] = [];
    await run(
      scriptedProvider([
        [plan(["Fill the form"])],
        [
          call("fill", { ref: "e1", text: "a" }),
          call("fill", { ref: "e2", text: "b" }),
          call("click", { ref: "e3" }),
        ],
      ]),
      makeDriver(calls),
    );

    // The submit ends the turn, and the model round trip after it is settle enough.
    expect(acted(calls)).toEqual(["fill", "settle", "fill", "settle", "click"]);
  });

  it("never settles on a single-call turn", async () => {
    const calls: string[] = [];
    await run(
      scriptedProvider([[plan(["Click it"])], [call("click", { ref: "e1" })]]),
      makeDriver(calls),
    );

    expect(acted(calls)).toEqual(["click"]);
  });

  it("does not settle after a scroll — scrolling cannot navigate", async () => {
    const calls: string[] = [];
    await run(
      scriptedProvider([
        [plan(["Look further down"])],
        [call("scroll_down"), call("click", { ref: "e1" })],
      ]),
      makeDriver(calls),
    );

    expect(acted(calls)).not.toContain("settle");
  });
});

describe("acting again on a page that moved mid-turn", () => {
  it("stops the batch when new elements appeared under it", async () => {
    const calls: string[] = [];
    const second = call("click", { ref: "e2" });
    // A menu opened, a validation error rendered, an autocomplete list appeared —
    // whatever e2 named in the model's snapshot may not be there any more.
    const wire = await run(
      scriptedProvider([[plan(["Click both"])], [call("click", { ref: "e1" }), second]]),
      makeDriver(calls, { newRefs: 3 }),
    );

    expect(acted(calls)).toEqual(["click", "settle"]);
    expect(allResults(wire).find((r) => r.id === second.id)?.content).toContain("snapshot");
  });

  it("lets the batch through when the page stayed put", async () => {
    const calls: string[] = [];
    await run(
      scriptedProvider([
        [plan(["Fill and submit"])],
        [call("fill", { ref: "e1", text: "a" }), call("click", { ref: "e2" })],
      ]),
      makeDriver(calls, { newRefs: 0 }),
    );

    expect(acted(calls)).toEqual(["fill", "settle", "click"]);
    expect(censuses(calls)).toBe(1); // one, before the click — none before the fill
  });

  it("never censuses before a turn's first action", async () => {
    const calls: string[] = [];
    // It is acting on the page the model actually looked at.
    await run(
      scriptedProvider([[plan(["Click it"])], [call("click", { ref: "e1" })]]),
      makeDriver(calls, { newRefs: 9 }),
    );

    expect(acted(calls)).toEqual(["click"]);
    expect(censuses(calls)).toBe(0);
  });

  it("needs no census after a navigation — the refs are gone by definition", async () => {
    const calls: string[] = [];
    const click = call("click", { ref: "e1" });
    const wire = await run(
      scriptedProvider([
        [plan(["Go and click"])],
        [call("navigate", { url: "https://example.com/next" }), click],
      ]),
      makeDriver(calls, { newRefs: 0 }), // a census here would report no change
    );

    expect(acted(calls)).toEqual(["navigate"]);
    expect(censuses(calls)).toBe(0);
    expect(allResults(wire).find((r) => r.id === click.id)?.content).toContain("snapshot");
  });

  it("stops the batch when the settle saw the page go somewhere", async () => {
    const calls: string[] = [];
    await run(
      scriptedProvider([
        [plan(["Click both"])],
        [call("click", { ref: "e1" }), call("click", { ref: "e2" })],
      ]),
      makeDriver(calls, { navigated: true, newRefs: 0 }),
    );

    expect(acted(calls)).toEqual(["click", "settle"]);
    expect(censuses(calls)).toBe(0); // settle already answered the question
  });

  it("does not treat a scroll as the page moving", async () => {
    const calls: string[] = [];
    // A lazy-loading page streams elements in as you scroll, and the ref the
    // model already saw is still perfectly good — censusing here would cancel
    // "scroll down, then click what I already saw" on every such page.
    await run(
      scriptedProvider([
        [plan(["Scroll and click"])],
        [call("scroll_down"), call("click", { ref: "e1" })],
      ]),
      makeDriver(calls, { newRefs: 12 }),
    );

    expect(acted(calls)).toEqual(["scroll_down", "click"]);
    expect(censuses(calls)).toBe(0);
  });

  it("never holds back a read — looking at what just changed is the right move", async () => {
    const calls: string[] = [];
    const look = call("snapshot");
    // The whole point of "click submit, then snapshot": one round trip, not two.
    const wire = await run(
      scriptedProvider([[plan(["Submit and check"])], [call("click", { ref: "e1" }), look]]),
      makeDriver(calls, { newRefs: 4 }),
    );

    expect(allResults(wire).find((r) => r.id === look.id)?.content).toContain("Page with a button");
  });
});
