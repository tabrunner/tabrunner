import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireRun, getOwnerRun, listActiveRuns, releaseRun } from "@/modules/agent/active-runs";
import type { ActiveRun } from "@/modules/agent/active-runs";
import { cancelQueued, listQueue } from "@/modules/agent/run-queue";
import type { StartRunOptions } from "@/modules/agent/start-run";
import type { Event } from "@/shared/protocol";
import type { ProviderConfig } from "@/modules/providers/types";
import type { DaemonMessage, ExtensionMessage, BridgeStatus } from "../protocol";
import { bridgeThread } from "../config";

const socket: {
  onMessage?: (message: DaemonMessage) => void;
  onOpen?: () => void;
  onDisconnect?: () => void;
} = {};
const sent: ExtensionMessage[] = [];
const runs = new Map<string, { opts: StartRunOptions; run: ActiveRun; finish: () => void }>();
const claims = new Map<number, string>();
const capture = vi.fn((tabId: number) => Promise.resolve(`data:image/jpeg;base64,${tabId}`));
const executeTool = vi.fn((..._args: unknown[]) =>
  Promise.resolve({ ok: true, data: { pageContent: "button" } }),
);
const appended = vi.fn((..._args: unknown[]) => Promise.resolve());
const applyTranscript = vi.fn();
let nextTab = 20;
let activeProvider: ProviderConfig | null = null;

vi.mock("../ws-client", () => ({
  BridgeSocket: class {
    constructor(
      onMessage: (message: DaemonMessage) => void,
      onOpen: () => void,
      onDisconnect: () => void,
    ) {
      Object.assign(socket, { onMessage, onOpen, onDisconnect });
    }
    start(): void {}
    send(message: ExtensionMessage): void {
      sent.push(message);
    }
  },
}));
vi.mock("@/modules/agent/start-run", () => ({
  startAgentRun: (opts: StartRunOptions) => {
    const acquired = acquireRun(opts.conversationId, opts.owner, opts.ownerId, opts.runId);
    if (!acquired.ok) return Promise.resolve({ ok: false, active: acquired.active });
    const run = acquired.run;
    return new Promise<{ ok: true }>((resolve) => {
      runs.set(run.id, {
        opts,
        run,
        finish: () => {
          releaseRun(run);
          runs.delete(run.id);
          resolve({ ok: true });
        },
      });
    });
  },
}));
vi.mock("@/modules/conversation", () => ({
  appendMessageTo: (...args: unknown[]) => appended(...args),
  openAgentConversation: () => Promise.resolve(),
  getThreadTabsFor: () => Promise.resolve({ tabs: [] }),
  recordDrivenTabFor: () => Promise.resolve(),
}));
vi.mock("@/modules/conversation/transcript", () => ({
  TranscriptWriter: class {
    constructor(readonly conversationId: string) {}
    apply(event: Event): void {
      applyTranscript(this.conversationId, event);
    }
  },
}));
vi.mock("@/modules/browser", () => ({
  createDriver: () => ({}),
  claimTab: (owner: string, tabId: number) => {
    if (claims.has(tabId) && claims.get(tabId) !== owner) throw new Error("tab in use");
    claims.set(tabId, owner);
  },
  tabOwner: (tabId: number) => claims.get(tabId) ?? null,
  isAttached: (tabId: number) => claims.has(tabId),
  releaseBrowserOwner: (owner: string) => {
    for (const [tabId, holder] of claims) if (holder === owner) claims.delete(tabId);
    return Promise.resolve();
  },
  showAgentIndicator: () => Promise.resolve(),
  hideAgentIndicator: () => Promise.resolve(),
  isRestrictedUrl: () => false,
  waitForLoad: () => Promise.resolve(),
  screenshot: (tabId: number) => capture(tabId),
}));
vi.mock("@/modules/agent/tools", () => ({
  executeTool: (...args: unknown[]) => executeTool(...args),
  formatSuccessSummary: () => "did the thing",
  formatDetail: () => undefined,
}));
vi.mock("@/modules/providers", () => ({
  getActiveProvider: () => Promise.resolve(activeProvider),
}));

const { Bridge } = await import("../bridge");

function request(
  clientId: string,
  requestId: string,
  method: string,
  params: Record<string, unknown> = {},
  runId?: string,
): void {
  socket.onMessage?.({
    type: "request",
    clientId,
    requestId,
    method,
    params,
    ...(runId ? { runId } : {}),
  });
}

async function response(requestId: string) {
  await vi.waitFor(() =>
    expect(
      sent.some((message) => message.type === "response" && message.requestId === requestId),
    ).toBe(true),
  );
  const message = sent.find(
    (message) => message.type === "response" && message.requestId === requestId,
  );
  if (!message || message.type !== "response") throw new Error("missing response");
  return message;
}

async function begin(clientId: string, requestId = `${clientId}-run`) {
  request(clientId, requestId, "run", { task: "read the page", agent: clientId });
  const answer = await response(requestId);
  expect(answer.ok).toBe(true);
  const result = answer.result as { runId: string; conversationId: string; queued?: number };
  return result;
}

function emit(runId: string, event: Event): void {
  runs.get(runId)?.opts.emit(event);
}

async function finish(runId: string): Promise<void> {
  emit(runId, { type: "done", summary: "done" });
  runs.get(runId)?.finish();
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  sent.length = 0;
  claims.clear();
  capture
    .mockReset()
    .mockImplementation((tabId: number) => Promise.resolve(`data:image/jpeg;base64,${tabId}`));
  applyTranscript.mockClear();
  appended.mockClear();
  executeTool.mockClear();
  nextTab = 20;
  activeProvider = null;
  Object.assign(chrome, {
    tabs: {
      query: () => Promise.resolve([{ id: 7, windowId: 1, url: "https://user.test/" }]),
      create: () => Promise.resolve({ id: nextTab++ }),
      get: (id: number) =>
        Promise.resolve({ id, windowId: 1, title: `Tab ${id}`, url: `https://${id}.test/` }),
      remove: () => Promise.resolve(),
      onRemoved: { addListener: () => {}, removeListener: () => {} },
    },
  });
});

afterEach(async () => {
  for (const entry of listQueue()) cancelQueued(entry.id);
  for (const { finish: drain } of [...runs.values()]) drain();
  for (const run of listActiveRuns()) releaseRun(run);
  await vi.advanceTimersByTimeAsync(0);
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("Bridge client ownership", () => {
  it("runs two clients concurrently with distinct threads, events and writers", async () => {
    const bridge = new Bridge();
    bridge.start();
    const a = await begin("a");
    const b = await begin("b");
    expect(a.conversationId).not.toBe(b.conversationId);
    expect(listActiveRuns()).toHaveLength(2);
    expect(bridge.activity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          clientId: "a",
          runId: a.runId,
          conversationId: a.conversationId,
        }),
        expect.objectContaining({
          clientId: "b",
          runId: b.runId,
          conversationId: b.conversationId,
        }),
      ]),
    );
    emit(a.runId, { type: "step", tool: "click", summary: "A clicked", ok: true });
    emit(b.runId, { type: "step", tool: "type", summary: "B typed", ok: true });
    expect(sent).toContainEqual({
      type: "event",
      clientId: "a",
      runId: a.runId,
      conversationId: a.conversationId,
      event: { type: "step", tool: "click", summary: "A clicked", ok: true },
    });
    expect(applyTranscript).toHaveBeenCalledWith(
      b.conversationId,
      expect.objectContaining({ summary: "B typed" }),
    );
    request("a", "a-status", "sync");
    expect((await response("a-status")).result).toMatchObject({
      steps: [{ summary: "A clicked" }],
    });
    await finish(a.runId);
    expect(bridge.activity).toEqual([expect.objectContaining({ clientId: "b" })]);
  });

  it("returns only the caller's queue and uses local positions", async () => {
    const bridge = new Bridge();
    bridge.start();
    await begin("a");
    await begin("b");
    await begin("b", "b-queued");
    const queued = await begin("a", "a-queued");
    expect(queued.queued).toBe(1);
    request("a", "a-queue", "sync");
    const status = (await response("a-queue")).result as BridgeStatus;
    expect(status.queue).toEqual([
      expect.objectContaining({
        runId: queued.runId,
        conversationId: queued.conversationId,
        position: 1,
      }),
    ]);
  });

  it("rejects cross-client and stale controls without stopping newer work", async () => {
    const bridge = new Bridge();
    bridge.start();
    const a = await begin("a");
    const b = await begin("b");
    for (const method of ["stop", "steer", "answer", "newConversation", "compact", "screenshot"]) {
      request("a", method, method, { text: "change it" }, b.runId);
      expect((await response(method)).error?.code).toBe("stale-run");
    }
    expect(getOwnerRun("bridge", "b")?.controller.signal.aborted).toBe(false);
    request("a", "steer-own", "steer", { text: "look again" }, a.runId);
    expect((await response("steer-own")).ok).toBe(true);
    expect(getOwnerRun("bridge", "a")?.injectedQueue).toEqual([
      expect.objectContaining({ text: "look again" }),
    ]);
    expect(getOwnerRun("bridge", "b")?.injectedQueue).toEqual([]);
    await finish(a.runId);
    const next = await begin("a", "a-next");
    request("a", "stale-stop", "stop", {}, a.runId);
    expect((await response("stale-stop")).error?.code).toBe("stale-run");
    expect(getOwnerRun("bridge", "a")?.id).toBe(next.runId);
    expect(getOwnerRun("bridge", "a")?.controller.signal.aborted).toBe(false);
  });

  it("aborts without freeing the owner lane until cleanup, and cancels only one queued ID", async () => {
    const bridge = new Bridge();
    bridge.start();
    const a = await begin("a");
    const q1 = await begin("a", "q1");
    const q2 = await begin("a", "q2");
    request("a", "cancel-one", "stop", {}, q1.runId);
    expect((await response("cancel-one")).ok).toBe(true);
    expect(listQueue().map((entry) => entry.id)).toEqual([q2.runId]);
    request("a", "stop-a", "stop", {}, a.runId);
    expect((await response("stop-a")).ok).toBe(true);
    expect(getOwnerRun("bridge", "a")?.id).toBe(a.runId);
    expect(getOwnerRun("bridge", "a")?.controller.signal.aborted).toBe(true);
    expect(runs.has(q2.runId)).toBe(false);
    await finish(a.runId);
    expect(runs.has(q2.runId)).toBe(true);
    expect(getOwnerRun("bridge", "a")?.id).toBe(q2.runId);
  });

  it("answers only the caller's current question once", async () => {
    const bridge = new Bridge();
    bridge.start();
    const a = await begin("a");
    const b = await begin("b");
    runs.get(a.runId)?.opts.onAskUser?.("Which account?", ["Work", "Home"]);
    runs.get(b.runId)?.opts.onAskUser?.("Send it?");
    request("b", "wrong-answer", "answer", { text: "Work" }, a.runId);
    expect((await response("wrong-answer")).error?.code).toBe("stale-run");
    request("a", "answer-a", "answer", { text: "Work" }, a.runId);
    expect((await response("answer-a")).ok).toBe(true);
    request("a", "answer-again", "answer", { text: "Home" }, a.runId);
    expect((await response("answer-again")).error?.code).toBe("no-question");
    expect(listQueue()).toHaveLength(1);
    request("b", "b-status", "sync");
    expect((await response("b-status")).result).toMatchObject({
      state: "question",
      question: "Send it?",
    });
  });

  it("resets only its own stored thread and resumes it across worker restarts", async () => {
    const first = new Bridge();
    first.start();
    const a = await begin("a");
    const b = await begin("b");
    await finish(a.runId);
    await finish(b.runId);
    const restarted = new Bridge();
    restarted.start();
    const resumed = await begin("a", "a-resume");
    expect(resumed.conversationId).toBe(a.conversationId);
    await finish(resumed.runId);
    request("a", "reset", "newConversation", {}, resumed.runId);
    expect((await response("reset")).ok).toBe(true);
    expect(await bridgeThread("b").get()).toBe(b.conversationId);
    expect((await begin("a", "a-reset")).conversationId).not.toBe(a.conversationId);
  });
});

describe("Bridge direct sessions and screenshots", () => {
  it("serializes a direct start/end and refuses delegated work in the same client", async () => {
    const bridge = new Bridge();
    bridge.start();
    request("a", "start", "browserStart", { goal: "read the form", agent: "Editor" });
    const started = await response("start");
    expect(started.ok).toBe(true);
    const direct = started.result as { runId: string; conversationId: string };
    request("a", "run-during-direct", "run", { task: "read elsewhere" });
    expect((await response("run-during-direct")).error?.code).toBe("already-running");
    const b = await begin("b");
    request("b", "wrong-end", "browserEnd", {}, direct.runId);
    expect((await response("wrong-end")).error?.code).toBe("stale-run");
    request("a", "end", "browserEnd", {}, direct.runId);
    expect((await response("end")).ok).toBe(true);
    expect(getOwnerRun("bridge", "b")?.id).toBe(b.runId);
    const resumed = await begin("a", "delegate-after-direct");
    expect(resumed.conversationId).toBe(direct.conversationId);
  });

  it("preserves a closed-tab tool result and frees only that client for another run", async () => {
    const bridge = new Bridge();
    bridge.start();
    request("a", "start", "browserStart", { goal: "read the form", agent: "Editor" });
    const direct = (await response("start")).result as { runId: string; conversationId: string };
    const b = await begin("b");
    vi.spyOn(chrome.tabs, "get").mockRejectedValue(new Error("No tab with id: 20."));
    executeTool.mockResolvedValueOnce({ ok: false, data: { pageContent: "tab closed" } });
    request("a", "closed-tab-action", "browserAct", { tool: "snapshot" }, direct.runId);
    expect(await response("closed-tab-action")).toMatchObject({
      ok: true,
      result: { ok: false, data: { pageContent: "tab closed" } },
    });
    expect(getOwnerRun("bridge", "a")).toBeNull();
    expect(claims.has(20)).toBe(false);
    expect(getOwnerRun("bridge", "b")?.id).toBe(b.runId);
    expect(getOwnerRun("bridge", "b")?.controller.signal.aborted).toBe(false);
    const resumed = await begin("a", "delegate-after-closed-tab");
    expect(resumed.conversationId).toBe(direct.conversationId);
  });

  it("does not hide unrelated Chrome metadata errors", async () => {
    const bridge = new Bridge();
    bridge.start();
    request("a", "start", "browserStart", { goal: "read the form", agent: "Editor" });
    const direct = (await response("start")).result as { runId: string };
    vi.spyOn(chrome.tabs, "get").mockRejectedValueOnce(new Error("Chrome connection failed"));
    request("a", "chrome-error", "browserAct", { tool: "snapshot" }, direct.runId);
    expect((await response("chrome-error")).error?.message).toBe("Chrome connection failed");
    expect(getOwnerRun("bridge", "a")?.id).toBe(direct.runId);
  });

  it("registers bounded external reads on their run and rejects reads once cleanup closes admission", async () => {
    const bridge = new Bridge();
    bridge.start();
    const a = await begin("a");
    const run = getOwnerRun("bridge", "a");
    if (!run) throw new Error("missing run");
    claims.set(31, a.runId);
    emit(a.runId, { type: "driving", tabId: 31, windowId: 1, title: "A" });
    capture.mockImplementationOnce(() => new Promise<string>(() => {}));
    request("a", "slow-shot", "screenshot", {}, a.runId);
    await vi.advanceTimersByTimeAsync(0);
    expect(run.pendingReads.size).toBe(1);
    await vi.advanceTimersByTimeAsync(5_001);
    expect((await response("slow-shot")).error?.code).toBe("capture-failed");
    expect(run.pendingReads.size).toBe(0);
    run.readsClosed = true;
    request("a", "closed-shot", "screenshot", {}, a.runId);
    expect((await response("closed-shot")).error?.code).toBe("stale-run");
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("holds a direct session's browser claim while a panel stop drains its external screenshot", async () => {
    const bridge = new Bridge();
    bridge.start();
    request("a", "start", "browserStart", { goal: "read the form", agent: "Editor" });
    const result = (await response("start")).result as { runId: string };
    const run = getOwnerRun("bridge", "a");
    if (!run) throw new Error("missing direct session");
    let resolveCapture!: (data: string) => void;
    capture.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveCapture = resolve;
        }),
    );
    request("a", "direct-shot", "screenshot", {}, result.runId);
    await vi.advanceTimersByTimeAsync(0);
    expect(run.pendingReads.size).toBe(1);
    bridge.stopFromPanel(run.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(getOwnerRun("bridge", "a")).toBe(run);
    expect(claims.get(20)).toBe(run.id);
    expect(run.readsClosed).toBe(true);
    resolveCapture("data:image/jpeg;base64,AA==");
    await response("direct-shot");
    await vi.advanceTimersByTimeAsync(0);
    expect(getOwnerRun("bridge", "a")).toBeNull();
    expect(claims.has(20)).toBe(false);
  });

  it("captures only its own claimed and attached tab with no visible-page fallback", async () => {
    const bridge = new Bridge();
    bridge.start();
    const a = await begin("a");
    const b = await begin("b");
    claims.set(31, a.runId);
    claims.set(32, b.runId);
    emit(a.runId, { type: "driving", tabId: 31, windowId: 1, title: "A" });
    emit(b.runId, { type: "driving", tabId: 32, windowId: 1, title: "B" });
    request("a", "shot-a", "screenshot", {}, a.runId);
    expect((await response("shot-a")).result).toMatchObject({ tabId: 31, driven: true });
    expect(capture).toHaveBeenCalledExactlyOnceWith(31);
    claims.delete(31);
    request("a", "shot-missing", "screenshot", {}, a.runId);
    expect((await response("shot-missing")).ok).toBe(false);
    expect(capture).toHaveBeenCalledTimes(1);
  });
});

describe("Bridge broker leases", () => {
  it("keeps a transient reconnect alive and resyncs each caller independently", async () => {
    const bridge = new Bridge();
    bridge.start();
    const a = await begin("a");
    const b = await begin("b");
    await vi.advanceTimersByTimeAsync(40_000);
    socket.onDisconnect?.();
    await vi.advanceTimersByTimeAsync(30_000);
    socket.onOpen?.();
    socket.onMessage?.({ type: "ping", clientIds: ["a", "b"] });
    request("a", "a-sync", "sync");
    request("b", "b-sync", "sync");
    expect((await response("a-sync")).result as BridgeStatus).toMatchObject({ runId: a.runId });
    expect((await response("b-sync")).result as BridgeStatus).toMatchObject({ runId: b.runId });
    expect(runs.size).toBe(2);
    expect(listActiveRuns().every((run) => !run.controller.signal.aborted)).toBe(true);
  });

  it("expires only missing bridge owners and sends close receipt after their drain", async () => {
    const bridge = new Bridge();
    bridge.start();
    const a = await begin("a");
    const b = await begin("b");
    const queued = await begin("a", "a-queued");
    const panel = acquireRun("panel-chat", "panel", "panel");
    const schedule = acquireRun("schedule-chat", "schedule", "schedule");
    expect(panel.ok && schedule.ok).toBe(true);
    await vi.advanceTimersByTimeAsync(40_000);
    socket.onMessage?.({ type: "ping", clientIds: ["b"] });
    await vi.advanceTimersByTimeAsync(20_001);
    expect(getOwnerRun("bridge", "a")?.controller.signal.aborted).toBe(true);
    expect(getOwnerRun("bridge", "b")?.controller.signal.aborted).toBe(false);
    expect(getOwnerRun("panel", "panel")?.controller.signal.aborted).toBe(false);
    expect(getOwnerRun("schedule", "schedule")?.controller.signal.aborted).toBe(false);
    expect(listQueue().some((entry) => entry.id === queued.runId)).toBe(false);
    request("a", "close-a", "closeClient");
    await vi.advanceTimersByTimeAsync(0);
    expect(
      sent.some((message) => message.type === "response" && message.requestId === "close-a"),
    ).toBe(false);
    await finish(a.runId);
    expect((await response("close-a")).result).toEqual({ ok: true });
    request("a", "late-run", "run", { task: "must not restart" });
    expect((await response("late-run")).error?.code).toBe("client-closing");
    expect(getOwnerRun("bridge", "a")).toBeNull();
    expect(getOwnerRun("bridge", "b")?.id).toBe(b.runId);
  });
});

describe("Bridge provider readiness", () => {
  it("reports a signed-in subscription under the current provider name", async () => {
    activeProvider = {
      id: "claude",
      name: "Anthropic",
      shape: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "",
      auth: { accessToken: "at", refreshToken: "rt", expiresAt: 0 },
      createdAt: 0,
    };
    new Bridge().start();
    request("a", "provider", "providerInfo");
    expect((await response("provider")).result).toEqual({
      name: "Claude (Subscription)",
      ready: true,
      auth: "subscription",
      model: null,
    });
  });

  it("reports a provider without a key as not ready", async () => {
    activeProvider = {
      id: "openai",
      name: "OpenAI (API)",
      shape: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      model: "gpt-5",
      createdAt: 0,
    };
    new Bridge().start();
    request("a", "provider", "providerInfo");
    expect((await response("provider")).result).toEqual({
      name: "OpenAI (API key)",
      ready: false,
      auth: "key",
      model: "gpt-5",
    });
  });

  it("reports missing configuration without failing the request", async () => {
    new Bridge().start();
    request("a", "provider", "providerInfo");
    expect((await response("provider")).result).toEqual({
      name: null,
      ready: false,
      auth: null,
      model: null,
    });
  });
});
