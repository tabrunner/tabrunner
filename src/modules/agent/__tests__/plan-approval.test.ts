import { describe, it, expect } from "vitest";
import { runAgentLoop } from "../loop";
import { i18n } from "@/i18n";
import type { BrowserDriver } from "@/modules/browser";
import type { SnapshotResult } from "@/modules/browser/snapshot";
import type { ChatMessage, ChatProvider, ToolCall } from "@/modules/providers/types";
import type { PlanApprovalPayload } from "@/shared/protocol";

// Storage stand-in and i18n come from src/test-setup.ts (vitest setupFiles).

const snapshot = async (): Promise<SnapshotResult> => ({
  pageContent: "Page with a button [ref=e1]",
  viewport: { width: 800, height: 600 },
  url: "https://example.com",
  title: "Example",
  newRefs: 0,
});

/** Driver stand-in — every method resolves a benign success; actions record their use. */
function makeDriver(calls: string[] = []): BrowserDriver {
  return {
    snapshot,
    navigate: async () => {
      calls.push("navigate");
    },
    click: async () => {
      calls.push("click");
      return { x: 1, y: 2 };
    },
    switchTab: async (tabId: number) => {
      calls.push(`switch_tab:${tabId}`);
      return { id: tabId, windowId: 1, title: "Inbox", url: "https://mail.example", active: false };
    },
  } as unknown as BrowserDriver;
}

/** Streams one scripted tool call per turn, in order, then done. */
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

const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({
  id: `c-${name}`,
  name,
  args,
});

const planCall = (steps: string[], current = 0, deviates?: boolean): ToolCall =>
  call("plan", {
    steps,
    current,
    ...(deviates !== undefined ? { deviates_from_approved: deviates } : {}),
  });

describe("runAgentLoop plan approval gate", () => {
  it("blocks an action tool called before any plan is approved", async () => {
    const calls: string[] = [];
    // Turn 1: model jumps straight to navigate — gate bounces it. Turn 2: it plans.
    const provider = scriptedProvider([
      [call("navigate", { url: "https://x.com" })],
      [planCall(["Go to X", "Read X"])],
    ]);
    const wire: ChatMessage[] = await runAgentLoop({
      provider,
      driver: makeDriver(calls),
      task: "go to x",
      signal: new AbortController().signal,
      callbacks: {},
    });

    expect(calls).toEqual([]); // navigate never executed
    // The bounced call's tool result tells the model how to unblock itself.
    const results = wire.find((m) => m.role === "tool_results")?.toolResults ?? [];
    expect(results[0]?.content).toContain(i18n.t("errors.planGateModel"));
  });

  it("gives the bounced step a drawer to open, not just a red mark", async () => {
    const steps: { tool: string; ok?: boolean; detail?: string }[] = [];
    const provider = scriptedProvider([[call("click", { ref: "e1" })], [planCall(["Click it"])]]);
    await runAgentLoop({
      provider,
      driver: makeDriver(),
      task: "click it",
      signal: new AbortController().signal,
      callbacks: {
        onStep: (s) => steps.push(s),
        onPlanApproval: async () => ({ approved: true }),
      },
    });

    const blocked = steps.find((s) => s.ok === false);
    expect(blocked?.tool).toBe("click");
    expect(blocked?.detail).toBe(i18n.t("errors.planGateModel"));
  });

  it("lets the agent reach the page it must read before it can plan", async () => {
    const calls: string[] = [];
    // Looking is not acting: the run starts on the tab it's driving, so
    // "go to the Gmail tab and see what's there" IS the opening move.
    const provider = scriptedProvider([
      [call("switch_tab", { tab_id: 7 }), call("snapshot")],
      [planCall(["Archive the newsletter"])],
    ]);
    await runAgentLoop({
      provider,
      driver: makeDriver(calls),
      task: "archive that newsletter",
      signal: new AbortController().signal,
      callbacks: { onPlanApproval: async () => ({ approved: true }) },
    });

    expect(calls).toContain("switch_tab:7");
  });

  it("runs a plan batched with its own first action, in that order", async () => {
    const calls: string[] = [];
    // Models routinely emit the plan and the step it opens with in one turn.
    // Wire order puts navigate first; executed as-is the gate would bounce it.
    const provider = scriptedProvider([
      [call("navigate", { url: "https://x.com" }), planCall(["Go to X", "Read X"])],
    ]);
    const wire: ChatMessage[] = await runAgentLoop({
      provider,
      driver: makeDriver(calls),
      task: "go to x",
      signal: new AbortController().signal,
      callbacks: { onPlanApproval: async () => ({ approved: true }) },
    });

    expect(calls).toEqual(["navigate"]);
    const results = wire.find((m) => m.role === "tool_results")?.toolResults ?? [];
    expect(results.some((r) => r.content.includes(i18n.t("errors.planGateModel")))).toBe(false);
  });

  it("parks on the first plan, then runs actions once approved", async () => {
    const calls: string[] = [];
    const approvals: PlanApprovalPayload[] = [];
    const provider = scriptedProvider([
      [planCall(["Go to X", "Read X"])],
      [call("navigate", { url: "https://x.com" })],
    ]);
    await runAgentLoop({
      provider,
      driver: makeDriver(calls),
      task: "go to x",
      signal: new AbortController().signal,
      callbacks: {
        onPlanApproval: async (ask) => {
          approvals.push(ask);
          return { approved: true };
        },
      },
    });

    expect(approvals).toEqual([{ steps: ["Go to X", "Read X"], current: 0, reapproval: false }]);
    expect(calls).toEqual(["navigate"]);
  });

  it("ends the run with the rejection summary when the plan is rejected", async () => {
    const calls: string[] = [];
    const summaries: (string | undefined)[] = [];
    const provider = scriptedProvider([[planCall(["Delete everything"])], [call("click")]]);
    await runAgentLoop({
      provider,
      driver: makeDriver(calls),
      task: "delete my account",
      signal: new AbortController().signal,
      callbacks: {
        onPlanApproval: async () => ({ approved: false }),
        onDone: (summary) => summaries.push(summary),
      },
    });

    expect(summaries).toEqual([i18n.t("errors.planRejected")]);
    expect(calls).toEqual([]); // nothing after the rejected plan ran
  });

  it("sends a rejected plan back with the revision note and re-asks the revised plan", async () => {
    const calls: string[] = [];
    const approvals: PlanApprovalPayload[] = [];
    const provider = scriptedProvider([
      [planCall(["Go to X", "Buy the thing"])],
      [planCall(["Go to X", "Read X"])], // the revised plan
      [call("navigate", { url: "https://x.com" })],
    ]);
    const wire: ChatMessage[] = await runAgentLoop({
      provider,
      driver: makeDriver(calls),
      task: "go to x",
      signal: new AbortController().signal,
      callbacks: {
        onPlanApproval: async (ask) => {
          approvals.push(ask);
          return approvals.length === 1
            ? { approved: false, feedback: "Do not buy anything" }
            : { approved: true };
        },
      },
    });

    // Both plans were asked about; the revision re-ask is a fresh first ask.
    // The revised list is diffed against the one the user sent back, not against
    // an approved plan there never was — "did it change what I asked?".
    expect(approvals).toEqual([
      { steps: ["Go to X", "Buy the thing"], current: 0, reapproval: false },
      {
        steps: ["Go to X", "Read X"],
        current: 0,
        reapproval: false,
        previous: ["Go to X", "Buy the thing"],
      },
    ]);
    // The note rode back in the first plan's own tool result.
    const results = wire.find((m) => m.role === "tool_results")?.toolResults ?? [];
    expect(results[0]?.content).toContain("Do not buy anything");
    // The gate re-armed between plans: nothing ran until the revised approval.
    expect(calls).toEqual(["navigate"]);
  });

  it("treats a blank revision note as a plain rejection", async () => {
    const summaries: (string | undefined)[] = [];
    const provider = scriptedProvider([[planCall(["Delete everything"])], [call("click")]]);
    await runAgentLoop({
      provider,
      driver: makeDriver(),
      task: "delete my account",
      signal: new AbortController().signal,
      callbacks: {
        onPlanApproval: async () => ({ approved: false, feedback: "   " }),
        onDone: (summary) => summaries.push(summary),
      },
    });

    expect(summaries).toEqual([i18n.t("errors.planRejected")]);
  });

  it("does not re-ask when a plan update only advances progress", async () => {
    const approvals: PlanApprovalPayload[] = [];
    const provider = scriptedProvider([
      [planCall(["Go to X", "Read X"])],
      [planCall(["Go to X", "Read X"], 1)],
    ]);
    await runAgentLoop({
      provider,
      driver: makeDriver(),
      task: "go to x",
      signal: new AbortController().signal,
      callbacks: {
        onPlanApproval: async (ask) => {
          approvals.push(ask);
          return { approved: true };
        },
      },
    });

    expect(approvals).toHaveLength(1); // only the first proposal asked
  });

  it("does not re-ask when a replan rewords steps without flagging a deviation", async () => {
    const approvals: PlanApprovalPayload[] = [];
    // The whole point of the flag: a reworded upcoming step is not a fresh ask.
    const provider = scriptedProvider([
      [planCall(["Go to X", "Read X"])],
      [planCall(["Go to X", "Read the X docs"], 1, false)],
    ]);
    await runAgentLoop({
      provider,
      driver: makeDriver(),
      task: "go to x",
      signal: new AbortController().signal,
      callbacks: {
        onPlanApproval: async (ask) => {
          approvals.push(ask);
          return { approved: true };
        },
      },
    });

    expect(approvals).toHaveLength(1); // only the first proposal asked
  });

  it("re-asks when the model flags its replan as deviating from the approved plan", async () => {
    const calls: string[] = [];
    const approvals: PlanApprovalPayload[] = [];
    const provider = scriptedProvider([
      [planCall(["Go to X", "Read X"])],
      [call("navigate", { url: "https://x.com" })],
      [planCall(["Go to X", "Buy the thing"], 1, true)], // flagged deviation — must re-ask
      [call("click")],
    ]);
    await runAgentLoop({
      provider,
      driver: makeDriver(calls),
      task: "go to x",
      signal: new AbortController().signal,
      callbacks: {
        onPlanApproval: async (ask) => {
          approvals.push(ask);
          return { approved: true };
        },
      },
    });

    // The re-ask carries the cursor and the list it replaces, not just the new
    // steps: the card marks the finished step done and the changed one new,
    // instead of asking for the whole trip again.
    expect(approvals).toEqual([
      { steps: ["Go to X", "Read X"], current: 0, reapproval: false },
      {
        steps: ["Go to X", "Buy the thing"],
        current: 1,
        reapproval: true,
        previous: ["Go to X", "Read X"],
      },
    ]);
    expect(calls).toEqual(["navigate", "click"]);
  });

  it("does not re-ask a replan that answers the user's own mid-run message", async () => {
    const calls: string[] = [];
    const approvals: PlanApprovalPayload[] = [];
    const queue = [{ id: "m1", text: "the purchase is handled already, move on" }];
    const provider = scriptedProvider([
      [planCall(["Go to X", "Buy the thing", "Confirm it"])],
      [call("navigate", { url: "https://x.com" })],
      // Answering the user's message: drops the purchase and flags the drop as
      // a deviation. Their message already approved what it asked for.
      [planCall(["Go to X", "Confirm it"], 1, true)],
      [call("click", { ref: "e1" })],
    ]);
    await runAgentLoop({
      provider,
      driver: makeDriver(calls),
      task: "buy the thing on x",
      signal: new AbortController().signal,
      drainInjected: () => queue.splice(0, queue.length),
      callbacks: {
        onPlanApproval: async (ask) => {
          approvals.push(ask);
          return { approved: true };
        },
      },
    });

    expect(approvals).toHaveLength(1); // only the first proposal asked
    expect(calls).toEqual(["navigate", "click"]); // the gate stayed open
  });

  it("re-asks a self-initiated deviation once the steering replan has passed", async () => {
    const approvals: PlanApprovalPayload[] = [];
    const queue = [{ id: "m1", text: "skip the reading" }];
    const provider = scriptedProvider([
      [planCall(["Go to X", "Read X", "Wrap up"])],
      [planCall(["Go to X", "Wrap up"], 1, true)], // answering the user — silent
      [planCall(["Go to X", "Buy the thing"], 1, true)], // the model's own idea — asks
    ]);
    await runAgentLoop({
      provider,
      driver: makeDriver(),
      task: "go to x",
      signal: new AbortController().signal,
      drainInjected: () => queue.splice(0, queue.length),
      callbacks: {
        onPlanApproval: async (ask) => {
          approvals.push(ask);
          return { approved: true };
        },
      },
    });

    // The steering yes is consumed by the first replan it prompted — a later
    // self-initiated deviation parks on its own.
    expect(approvals).toEqual([
      { steps: ["Go to X", "Read X", "Wrap up"], current: 0, reapproval: false },
      {
        steps: ["Go to X", "Buy the thing"],
        current: 1,
        reapproval: true,
        // The silent steering replan never reached the user, so the diff is
        // still against the last list they actually saw.
        previous: ["Go to X", "Read X", "Wrap up"],
      },
    ]);
  });

  it("auto-approves when no onPlanApproval callback is wired", async () => {
    const calls: string[] = [];
    const provider = scriptedProvider([
      [planCall(["Go to X"])],
      [call("navigate", { url: "https://x.com" })],
    ]);
    await runAgentLoop({
      provider,
      driver: makeDriver(calls),
      task: "go to x",
      signal: new AbortController().signal,
      callbacks: {},
    });

    expect(calls).toEqual(["navigate"]);
  });

  it("nudges for the whole arc when a replan drops finished steps, and lands anyway", async () => {
    const plans: string[][] = [];
    const provider = scriptedProvider([
      [planCall(["Go to X", "Read X", "Wrap up"], 2)],
      [planCall(["Wrap up"], 0, false)], // narrowed — the finished steps vanished
      [planCall(["Go to X", "Read X", "Wrap up"], 2)], // re-sent whole after the note
    ]);
    const wire: ChatMessage[] = await runAgentLoop({
      provider,
      driver: makeDriver(),
      task: "go to x",
      signal: new AbortController().signal,
      callbacks: {
        onPlanApproval: async () => ({ approved: true }),
        onPlan: (p) => plans.push(p.steps),
      },
    });

    // The narrowed list still became the card — the model is the list's one
    // writer; the note only asks it to re-send the whole arc.
    expect(plans[1]).toEqual(["Wrap up"]);
    const planResults = wire
      .filter((m) => m.role === "tool_results")
      .flatMap((m) => m.toolResults ?? [])
      .filter((r) => r.id === "c-plan");
    expect(planResults[0]?.content).not.toContain("whole arc");
    expect(planResults[1]?.content).toContain(i18n.t("plan.narrowedNote"));
    expect(planResults[2]?.content).not.toContain("whole arc"); // converged, no repeat
  });
});
