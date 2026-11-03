import { describe, it, expect } from "vitest";
import { runAgentLoop } from "../loop";
import type { BrowserDriver } from "@/modules/browser";
import type { SnapshotResult } from "@/modules/browser/snapshot";
import type { ChatProvider, ToolCall } from "@/modules/providers/types";
import type { PlanApprovalPayload } from "@/shared/protocol";

// Storage stand-in and i18n come from src/test-setup.ts (vitest setupFiles).

const snapshot = async (): Promise<SnapshotResult> => ({
  pageContent: "Page with a button [ref=e1]",
  viewport: { width: 800, height: 600 },
  url: "https://example.com",
  title: "Example",
  newRefs: 0,
});

/** A page whose one button is named `label`; clicks are recorded. */
function makeDriver(label: string, calls: string[]): BrowserDriver {
  return {
    snapshot,
    describeTarget: async () => ({ name: label, paysByCard: false }),
    click: async () => {
      calls.push("click");
      return { x: 1, y: 2 };
    },
  } as unknown as BrowserDriver;
}

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

const plan = call("plan", {
  steps: ["Open the cart", "Place the order"],
  current: 0,
  deviates_from_approved: false,
  confirm_steps: [1, 7, 1],
});

/** Runs a click through an auto-approved plan and answers every card with `answer`. */
async function run(
  label: string,
  clickArgs: Record<string, unknown>,
  answer: { approved: boolean; feedback?: string },
) {
  const clicks: string[] = [];
  const asks: PlanApprovalPayload[] = [];
  const plans: number[][] = [];
  const wire = await runAgentLoop({
    provider: scriptedProvider([[plan], [call("click", { ref: "e1", ...clickArgs })]]),
    driver: makeDriver(label, clicks),
    task: "order it",
    autoApprovePlan: true,
    signal: new AbortController().signal,
    callbacks: {
      onPlan: (p) => plans.push(p.confirm ?? []),
      onPlanApproval: async (ask) => {
        asks.push(ask);
        return answer;
      },
    },
  });
  return { clicks, asks, plans, wire };
}

describe("auto-approved plan", () => {
  it("starts without a plan card, and keeps only valid, unique confirm indexes", async () => {
    const { asks, plans } = await run("Next", { commits: false }, { approved: true });
    expect(plans[0]).toEqual([1]);
    expect(asks).toEqual([]);
  });

  it("parks on a click the model says commits, and runs it once allowed", async () => {
    const { asks, clicks } = await run("Continue", { commits: true }, { approved: true });
    expect(asks).toHaveLength(1);
    expect(asks[0]?.action).toBe("Click “Continue”");
    expect(clicks).toEqual(["click"]);
  });

  it("parks on a label that reads as a commit even when the model said false", async () => {
    const { asks, clicks } = await run("Finalizar compra", { commits: false }, { approved: true });
    expect(asks.map((a) => a.action)).toEqual(["Click “Finalizar compra”"]);
    expect(clicks).toEqual(["click"]);
  });

  it("never runs a declined click and tells the model, with the user's note", async () => {
    const { clicks, wire } = await run(
      "Place order",
      { commits: true },
      { approved: false, feedback: "use my other card" },
    );
    expect(clicks).toEqual([]);
    const results = wire.flatMap((m) => (m.role === "tool_results" ? (m.toolResults ?? []) : []));
    const declined = results.find((r) => r.content.includes("declined"));
    expect(declined?.content).toContain("use my other card");
  });
});
