import { describe, it, expect, vi, afterEach } from "vitest";
import { runAgentLoop, MAX_STEPS } from "../loop";
import { i18n } from "@/i18n";
import type { BrowserDriver } from "@/modules/browser";
import type { SnapshotResult } from "@/modules/browser/snapshot";
import type { ChatMessage, ChatProvider } from "@/modules/providers/types";
import { ProviderError } from "@/modules/providers/types";

// Storage stand-in and i18n come from src/test-setup.ts (vitest setupFiles).

// Tests: one-method stand-in — the loop only ever calls snapshot() on this path.
const driver = {
  snapshot: async (): Promise<SnapshotResult> => ({
    pageContent: "Page with a button [ref=e1]",
    viewport: { width: 800, height: 600 },
    url: "https://example.com",
    title: "Example",
    newRefs: 0,
  }),
} as unknown as BrowserDriver;

/** Streams a single `done` tool call so the loop ends after one step. */
function providerThatEndsWithDone(captured: { messages?: ChatMessage[] }): ChatProvider {
  return {
    async *stream(messages) {
      captured.messages = messages;
      yield { type: "tool_use", id: "c1", name: "done", args: { summary: "ok" } };
      yield { type: "done" };
    },
  };
}

describe("runAgentLoop image handling", () => {
  it("strips user-attached images before they reach a text-only provider", async () => {
    const captured: { messages?: ChatMessage[] } = {};
    const steps: { tool: string; summary?: string }[] = [];
    await runAgentLoop({
      provider: providerThatEndsWithDone(captured),
      driver,
      task: "Check the screenshot [Image #1]",
      images: ["data:image/jpeg;base64,AAAA"],
      supportsImages: false,
      signal: new AbortController().signal,
      callbacks: { onStep: (s) => steps.push(s) },
    });

    const taskMessage = captured.messages?.find((m) => m.role === "user");
    expect(taskMessage?.images).toBeUndefined();
    // The drop is an informational step, not an error that stops the run.
    expect(steps[0]).toEqual({ tool: "warn", summary: i18n.t("errors.textOnlyImages") });
  });

  it("keeps user-attached images for image-capable providers", async () => {
    const captured: { messages?: ChatMessage[] } = {};
    await runAgentLoop({
      provider: providerThatEndsWithDone(captured),
      driver,
      task: "Check the screenshot [Image #1]",
      images: ["data:image/jpeg;base64,AAAA"],
      signal: new AbortController().signal,
      callbacks: {},
    });

    const taskMessage = captured.messages?.find((m) => m.role === "user");
    expect(taskMessage?.images).toEqual(["data:image/jpeg;base64,AAAA"]);
  });
});

describe("runAgentLoop mid-run queue", () => {
  it("drains the queue at a tool boundary — the model sees it and the panel is told", async () => {
    const queue = [{ id: "m1", text: "also check this" }];
    const injected: string[] = [];
    let calls = 0;
    let sawSteer = false;
    const provider: ChatProvider = {
      async *stream(messages) {
        calls++;
        // The turn after the snapshot must already carry the user's message.
        if (calls === 2) {
          sawSteer = messages.some((m) => m.role === "user" && m.content === "also check this");
          yield { type: "tool_use", id: "d1", name: "done", args: { summary: "ok" } };
        } else {
          yield { type: "tool_use", id: `c${calls}`, name: "snapshot", args: {} };
        }
        yield { type: "done" };
      },
    };
    await runAgentLoop({
      provider,
      driver,
      task: "do it",
      signal: new AbortController().signal,
      drainInjected: () => queue.splice(0, queue.length),
      callbacks: { onInjected: (id, text) => injected.push(text) },
    });

    expect(injected).toEqual(["also check this"]);
    expect(queue).toHaveLength(0);
    expect(sawSteer).toBe(true);
  });

  it("leaves the queue alone when the run ends — the panel recalls it, no phantom bubble", async () => {
    const queue = [{ id: "m1", text: "one more thing" }];
    const injected: string[] = [];
    await runAgentLoop({
      provider: providerThatEndsWithDone({}),
      driver,
      task: "do it",
      signal: new AbortController().signal,
      drainInjected: () => queue.splice(0, queue.length),
      callbacks: { onInjected: (id, text) => injected.push(text) },
    });

    // Draining on the done step would bubble a message the model never saw.
    expect(injected).toEqual([]);
    expect(queue).toHaveLength(1);
  });
});

describe("runAgentLoop stream retries", () => {
  afterEach(() => vi.restoreAllMocks());

  it("gives auth failures a longer trial than the standard stream budget", async () => {
    // Backoff is random*ceiling; pinning random to 0 makes every sleep instant.
    vi.spyOn(Math, "random").mockReturnValue(0);
    let attempts = 0;
    const retrySteps: { summary?: string }[] = [];
    const provider: ChatProvider = {
      async *stream() {
        attempts++;
        // Four straight failures outlast the standard 3-attempt budget — only
        // the auth ceiling carries the run to the fifth attempt, which lands.
        if (attempts <= 4) throw new ProviderError("invalid credentials", 401, "auth");
        yield { type: "tool_use", id: "d1", name: "done", args: { summary: "ok" } };
        yield { type: "done" };
      },
    };
    const summaries: (string | undefined)[] = [];
    await runAgentLoop({
      provider,
      driver,
      task: "go",
      signal: new AbortController().signal,
      callbacks: {
        onStep: (s) => {
          if (s.tool === "retry") retrySteps.push(s);
        },
        onDone: (s) => summaries.push(s),
      },
    });

    expect(attempts).toBe(5);
    expect(summaries).toEqual(["ok"]);
    // The visible retry rows name the auth budget, not the standard one.
    expect(retrySteps).toHaveLength(4);
    expect(retrySteps[0]?.summary).toContain("1/5");
  });

  it("gives a dropped connection the same longer trial — waiting is the whole fix", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    let attempts = 0;
    const provider: ChatProvider = {
      async *stream() {
        attempts++;
        // A wifi handover outlasts the standard ≈3s budget; the fifth attempt
        // is the one that finds the network back.
        if (attempts <= 4) throw new ProviderError("offline", 0, "network");
        yield { type: "tool_use", id: "d1", name: "done", args: { summary: "ok" } };
        yield { type: "done" };
      },
    };
    const summaries: (string | undefined)[] = [];
    await runAgentLoop({
      provider,
      driver,
      task: "go",
      signal: new AbortController().signal,
      callbacks: { onDone: (s) => summaries.push(s) },
    });

    expect(attempts).toBe(5);
    expect(summaries).toEqual(["ok"]);
  });

  it("keeps the standard budget for the ordinary retryables", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    let attempts = 0;
    const provider: ChatProvider = {
      async *stream() {
        attempts++;
        if (attempts > 0) throw new ProviderError("upstream is busy", 503, "overload");
        yield { type: "done" };
      },
    };
    const errors: string[] = [];
    await runAgentLoop({
      provider,
      driver,
      task: "go",
      signal: new AbortController().signal,
      callbacks: { onError: (message) => errors.push(message) },
    });

    expect(attempts).toBe(3);
    expect(errors).toHaveLength(1);
  });
});

describe("runAgentLoop step budget", () => {
  it("lets the model ask the user whether to continue as the budget runs out", async () => {
    const question = "I've filled 12 of 20 fields on the quote form. Keep digging?";
    let calls = 0;
    let sawNearEndNudge = false;
    const provider: ChatProvider = {
      async *stream(messages) {
        calls++;
        // The near-end nudge (offering ask_user) is pushed the turn before the model asks.
        const last = messages[messages.length - 1];
        if (last?.role === "user" && last.content.includes("ask_user")) sawNearEndNudge = true;
        if (calls === MAX_STEPS - 1) {
          // Step MAX_STEPS - 2 — the turn the near-end nudge was pushed into.
          yield { type: "tool_use", id: "c1", name: "ask_user", args: { question } };
        } else {
          yield { type: "tool_use", id: "c1", name: "snapshot", args: {} };
        }
        yield { type: "done" };
      },
    };
    const asked: string[] = [];
    await runAgentLoop({
      provider,
      driver,
      task: "Fill the quote form",
      signal: new AbortController().signal,
      callbacks: { onAskUser: (q) => asked.push(q) },
    });

    // The question ended the run (not the exhausted-budget fallback), and the
    // continuation choice was on the table when the model took it.
    expect(sawNearEndNudge).toBe(true);
    expect(asked).toEqual([question]);
  });

  it("closes gracefully when the model ignores the budget nudges", async () => {
    const provider: ChatProvider = {
      async *stream() {
        yield { type: "tool_use", id: "c1", name: "snapshot", args: {} };
        yield { type: "done" };
      },
    };
    let doneSummary: string | undefined;
    await runAgentLoop({
      provider,
      driver,
      task: "Keep going",
      signal: new AbortController().signal,
      callbacks: { onDone: (s) => (doneSummary = s) },
    });

    expect(doneSummary).toBe(i18n.t("errors.stepBudgetExhausted"));
  });
});

describe("runAgentLoop context growth", () => {
  // A long run re-sends every tool result on every turn, so an untrimmed
  // transcript grows until the provider rejects the body — a raw
  // context-length 400 mid-task, which is the dead end the step budget's
  // checkpoint exists to avoid. Only the newest results keep their payload.
  it("bounds accumulated tool-result text, keeping the newest intact", async () => {
    const PAGE = "x".repeat(50_000); // one big page snapshot per step
    const STEPS = 20; // 20 × 50k = 1MB untrimmed
    let calls = 0;
    let widest = 0;
    const provider: ChatProvider = {
      async *stream(messages) {
        calls++;
        const size = messages.reduce(
          (sum, m) => sum + (m.toolResults ?? []).reduce((n, r) => n + r.content.length, 0),
          0,
        );
        widest = Math.max(widest, size);
        if (calls > STEPS)
          yield { type: "tool_use", id: "c1", name: "done", args: { summary: "ok" } };
        else yield { type: "tool_use", id: `c${calls}`, name: "snapshot", args: {} };
        yield { type: "done" };
      },
    };
    const bigDriver = {
      snapshot: async (): Promise<SnapshotResult> => ({
        pageContent: PAGE,
        viewport: { width: 800, height: 600 },
        url: "https://example.com",
        title: "Example",
        newRefs: 0,
      }),
    } as unknown as BrowserDriver;

    const wire = await runAgentLoop({
      provider,
      driver: bigDriver,
      task: "Read many pages",
      signal: new AbortController().signal,
      callbacks: {},
    });

    // Bounded, not unbounded: well under the 1MB an untrimmed run would carry.
    expect(widest).toBeLessThan(300_000);
    // The newest result still carries its real payload — trimming the page the
    // model is standing on would blind it.
    const newest = wire.findLast((m) => m.toolResults?.length)?.toolResults?.[0];
    expect(newest?.content).toContain("x".repeat(1000));
  });
});

describe("runAgentLoop output-limit recovery", () => {
  // Qwen/DeepSeek thinking gateways split one max_tokens between reasoning and
  // the answer, so a report-writing turn gets cut mid-`done`. The report the
  // model wrote is the turn's streamed text — the run must close on it, not on
  // a hollow "task complete".
  it("closes a truncated done on the turn's streamed text, not the empty summary", async () => {
    const provider: ChatProvider = {
      async *stream() {
        yield { type: "text", text: "Tier 1: olharyapp, olharyco. Tier 2: useolhary." };
        // Cut mid-`done` — parseToolArgs already reduced the args to {}.
        yield { type: "tool_use", id: "c1", name: "done", args: {} };
        yield { type: "finish", reason: "length" };
        yield { type: "done" };
      },
    };
    let doneSummary: string | undefined;
    await runAgentLoop({
      provider,
      driver,
      task: "Rank the domains",
      signal: new AbortController().signal,
      callbacks: { onDone: (s) => (doneSummary = s) },
    });

    expect(doneSummary).toBe("Tier 1: olharyapp, olharyco. Tier 2: useolhary.");
  });

  it("recovers an emptied done with one plain-text retry instead of closing hollow", async () => {
    let calls = 0;
    const provider: ChatProvider = {
      async *stream() {
        calls++;
        if (calls === 1) {
          // Everything cut: no text, a done whose summary never made it.
          yield { type: "tool_use", id: "c1", name: "done", args: {} };
          yield { type: "finish", reason: "length" };
          yield { type: "done" };
        } else {
          // The recovery note asked for the answer plainly — text, then a clean done.
          yield { type: "text", text: "The answer, restated short." };
          yield { type: "tool_use", id: "c2", name: "done", args: {} };
          yield { type: "done" };
        }
      },
    };
    let doneSummary: string | undefined;
    const steps: { tool: string; summary?: string }[] = [];
    await runAgentLoop({
      provider,
      driver,
      task: "Rank the domains",
      signal: new AbortController().signal,
      callbacks: { onDone: (s) => (doneSummary = s), onStep: (s) => steps.push(s) },
    });

    expect(calls).toBe(2);
    expect(doneSummary).toBe("The answer, restated short.");
    // The retry surfaced the output-limit warning exactly once.
    expect(steps.filter((s) => s.tool === "warn")).toHaveLength(1);
  });

  it("never loops: a model that keeps truncating still closes", async () => {
    const provider: ChatProvider = {
      async *stream() {
        yield { type: "tool_use", id: "c1", name: "done", args: {} };
        yield { type: "finish", reason: "length" };
        yield { type: "done" };
      },
    };
    let doneSummary: string | undefined;
    await runAgentLoop({
      provider,
      driver,
      task: "Rank the domains",
      signal: new AbortController().signal,
      callbacks: { onDone: (s) => (doneSummary = s) },
    });

    expect(doneSummary).toBe(i18n.t("errors.taskComplete"));
  });
});

describe("runAgentLoop truncated text-only turn", () => {
  // The cap cut the whole tool call but the report text survived: the nudge
  // must point at the cheap close (a done over the text already written), not
  // send the model back to reason a second pass over the same budget.
  it("nudges a truncated text-only turn toward closing, not re-reasoning", async () => {
    let calls = 0;
    let nudge: string | undefined;
    const provider: ChatProvider = {
      async *stream(messages) {
        calls++;
        if (calls === 1) {
          yield { type: "text", text: "The full report." };
          yield { type: "finish", reason: "length" };
          yield { type: "done" };
        } else {
          nudge = messages
            .filter((m) => m.role === "user")
            .map((m) => m.content)
            .at(-1);
          yield { type: "tool_use", id: "c1", name: "done", args: { summary: "The full report." } };
          yield { type: "done" };
        }
      },
    };
    await runAgentLoop({
      provider,
      driver,
      task: "Rank the domains",
      signal: new AbortController().signal,
      callbacks: {},
    });

    expect(nudge).toContain("output limit");
    expect(nudge).toContain("call `done`");
    // The ask is "restate it in full", never "summarize it short" — no length
    // pressure in either direction after a length error.
    expect(nudge).toContain("restated in full");
    expect(nudge).not.toContain("sentence");
    expect(nudge).not.toContain("short");
  });
});
