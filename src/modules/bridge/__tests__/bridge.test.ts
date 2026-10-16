import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireRun, getActiveRun, releaseRun } from "@/modules/agent/active-runs";
import type { Event } from "@/shared/protocol";
import type { ProviderConfig } from "@/modules/providers/types";
import type { DaemonMessage } from "../protocol";

/**
 * The panel indicator. bridge.ts must say, truthfully, when an external client
 * is working in the browser — a delegated run, or a direct-driving session —
 * and stop saying it the moment the work ends. The panel band, the driven tab's
 * favicon dot and the on-page badge all key off this one getter, so the
 * lifecycle is the part worth pinning: set on start, cleared on done/error,
 * cleared when a direct session closes (stop and idle expiry included).
 *
 * The socket, the run engine and the browser are all mocked: this drives the
 * request wiring and the activity transitions, not CDP or streaming.
 */

const socketHandlers: { onMessage?: (msg: DaemonMessage) => void } = {};
const sendSpy = vi.fn();
let emitRunEvent: ((e: Event) => void) | null = null;

vi.mock("@/modules/bridge/ws-client", () => ({
  BridgeSocket: class {
    send = sendSpy;
    constructor(onMessage: (msg: DaemonMessage) => void) {
      socketHandlers.onMessage = onMessage;
    }
    start(): void {}
  },
}));
vi.mock("@/modules/agent/start-run", () => ({
  startAgentRun: (opts: { emit: (e: Event) => void }) => {
    emitRunEvent = opts.emit;
    return Promise.resolve({ ok: true });
  },
}));
vi.mock("@/modules/conversation", () => ({
  appendMessageTo: () => Promise.resolve(),
  openAgentConversation: () => Promise.resolve(),
}));
vi.mock("@/modules/conversation/transcript", () => ({
  TranscriptWriter: class {
    apply(): void {}
  },
}));
vi.mock("@/modules/browser", () => ({
  createDriver: () => ({}),
  showAgentIndicator: () => Promise.resolve(),
  hideAgentIndicator: () => Promise.resolve(),
  detachAll: () => Promise.resolve(),
  isRestrictedUrl: () => false,
  waitForLoad: () => Promise.resolve(),
  captureVisibleTab: () => Promise.resolve({ data: "data:image/jpeg;base64,AA==", tabId: 7 }),
  attachedTab: () => attachedTabId,
  screenshot: () => Promise.resolve("data:image/jpeg;base64,CC=="),
}));
/** The tab the debugger session holds, or null when no run or session is live. */
let attachedTabId: number | null = null;
let activeProvider: ProviderConfig | null = null;
vi.mock("@/modules/providers", () => ({
  getActiveProvider: () => Promise.resolve(activeProvider),
}));
vi.mock("@/modules/agent/tools", () => ({
  executeTool: () => Promise.resolve({ ok: true, data: { pageContent: "[ref=e1] button" } }),
  formatSuccessSummary: () => "did the thing",
  formatDetail: () => undefined,
}));

const { Bridge } = await import("../bridge");

type Activity = { mode: "run" | "direct"; client: string } | null;

beforeEach(() => {
  sendSpy.mockClear();
  emitRunEvent = null;
  activeProvider = null;
  attachedTabId = null;
  delete socketHandlers.onMessage;
  (globalThis.chrome as Record<string, unknown>).tabs = {
    query: () => Promise.resolve([{ id: 7, windowId: 1, title: "Inbox", url: "https://x.test/" }]),
    get: (id: number) => Promise.resolve({ id, title: "Form", url: "https://y.test/" }),
    onRemoved: { addListener: () => {}, removeListener: () => {} },
    onUpdated: { addListener: () => {}, removeListener: () => {} },
  };
});

afterEach(() => {
  const run = getActiveRun();
  if (run) releaseRun(run);
});

describe("Bridge activity", () => {
  it("names the client during a delegated run and falls silent when it ends", async () => {
    const seen: Activity[] = [];
    const bridge = new Bridge((active) => seen.push(active));
    bridge.start();

    socketHandlers.onMessage?.({
      type: "request",
      requestId: "r1",
      method: "run",
      params: { task: "do the thing", agent: "Claude Code" },
    });
    await vi.waitFor(() => expect(bridge.activity).toEqual({ mode: "run", client: "Claude Code" }));
    expect(seen).toEqual([{ mode: "run", client: "Claude Code" }]);

    // Activity is set before launch() reaches startAgentRun, which is what
    // captures the emit callback — wait for the capture, or the done lands on
    // nothing and the run reads as still live.
    await vi.waitFor(() => expect(emitRunEvent).not.toBeNull());
    emitRunEvent?.({ type: "done", summary: "done" });
    await vi.waitFor(() => expect(bridge.activity).toBeNull());
    expect(seen).toEqual([{ mode: "run", client: "Claude Code" }, null]);
  });

  it("clears activity on a run error too", async () => {
    const bridge = new Bridge();
    bridge.start();

    socketHandlers.onMessage?.({
      type: "request",
      requestId: "r1",
      method: "run",
      params: { task: "do the thing", agent: "Claude Code" },
    });
    await vi.waitFor(() => expect(bridge.activity).not.toBeNull());
    await vi.waitFor(() => expect(emitRunEvent).not.toBeNull());

    emitRunEvent?.({ type: "error", message: "provider blew up" });
    await vi.waitFor(() => expect(bridge.activity).toBeNull());
  });

  it("names the client during direct driving and falls silent when the session closes", async () => {
    const seen: Activity[] = [];
    const bridge = new Bridge((active) => seen.push(active));
    bridge.start();

    socketHandlers.onMessage?.({
      type: "request",
      requestId: "r2",
      method: "browserStart",
      params: { goal: "find the invoice", agent: "Claude Code" },
    });
    await vi.waitFor(() =>
      expect(bridge.activity).toEqual({ mode: "direct", client: "Claude Code" }),
    );
    expect(seen).toEqual([{ mode: "direct", client: "Claude Code" }]);

    socketHandlers.onMessage?.({
      type: "request",
      requestId: "r3",
      method: "browserEnd",
      params: {},
    });
    await vi.waitFor(() => expect(bridge.activity).toBeNull());
    expect(seen).toEqual([{ mode: "direct", client: "Claude Code" }, null]);
  });

  it("does not claim the browser when a direct session refuses to open", async () => {
    // The panel holds the slot — browser_start must fail without activity, and
    // the refusal has to reach the client, not die in the bridge.
    acquireRun("panel-conversation", "panel");
    const bridge = new Bridge();
    bridge.start();

    socketHandlers.onMessage?.({
      type: "request",
      requestId: "r4",
      method: "browserStart",
      params: { goal: "find the invoice", agent: "Claude Code" },
    });
    await vi.waitFor(() =>
      expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ requestId: "r4", ok: false })),
    );

    expect(bridge.activity).toBeNull();
  });
});

/**
 * health asks this before a task is sent: a reachable browser with no usable
 * provider is a run that dies on its first model call. Every field feeds a
 * different line of the answer, so each one is worth pinning.
 */
describe("Bridge providerInfo", () => {
  const ask = async (requestId: string) => {
    const bridge = new Bridge();
    bridge.start();
    socketHandlers.onMessage?.({ type: "request", requestId, method: "providerInfo", params: {} });
    await vi.waitFor(() =>
      expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ requestId })),
    );
    const call = sendSpy.mock.calls.find(
      (c) => (c[0] as { requestId?: string }).requestId === requestId,
    );
    return (call?.[0] as { result: unknown }).result;
  };

  it("reports a signed-in subscription as ready, under its display name", async () => {
    activeProvider = {
      id: "claude",
      // The name storage held before the row was renamed to "Claude" — the
      // preset's current one wins, so nobody has to re-save to see it.
      name: "Anthropic",
      shape: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "",
      auth: { accessToken: "at", refreshToken: "rt", expiresAt: 0 },
      createdAt: 0,
    };
    expect(await ask("p1")).toEqual({
      name: "Claude (Subscription)",
      ready: true,
      auth: "subscription",
      model: null,
    });
  });

  it("reports a keyless provider as not ready, so health can say which fix applies", async () => {
    activeProvider = {
      id: "openai",
      name: "OpenAI (API)",
      shape: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      model: "gpt-5",
      createdAt: 0,
    };
    expect(await ask("p2")).toEqual({
      name: "OpenAI (API key)",
      ready: false,
      auth: "key",
      model: "gpt-5",
    });
  });

  it("reports no provider at all rather than failing the request", async () => {
    expect(await ask("p3")).toEqual({ name: null, ready: false, auth: null, model: null });
  });
});

/**
 * The MCP thread outlives the worker. Chrome suspends the service worker after
 * ~30s idle and destroys it on every reload and version update, so a thread id
 * held in the Bridge instance meant the next run silently started a stranger's
 * conversation — the client lost the pages it had visited and the user was left
 * with an orphaned transcript. The id lives in storage now; only
 * new_conversation ends the thread.
 */
describe("Bridge thread", () => {
  /** The conversationId a run's response carries back to the daemon. */
  function threadOf(requestId: string): string | undefined {
    const call = sendSpy.mock.calls.find(
      ([m]) => m?.type === "response" && m.requestId === requestId,
    );
    return (call?.[0] as { result?: { conversationId?: string } } | undefined)?.result
      ?.conversationId;
  }

  /** One full run — dispatched, then finished, so the slot is free for the next. */
  async function runOnce(bridge: InstanceType<typeof Bridge>, requestId: string): Promise<string> {
    // Identity, not null: the previous run's emit is still on the module-level
    // slot, so "not null" would pass before this run had started at all.
    const previous = emitRunEvent;
    socketHandlers.onMessage?.({
      type: "request",
      requestId,
      method: "run",
      params: { task: "read the page", agent: "Claude Code" },
    });
    await vi.waitFor(() => expect(emitRunEvent).not.toBe(previous));
    emitRunEvent?.({ type: "done", summary: "done" });
    await vi.waitFor(() => expect(bridge.activity).toBeNull());
    const id = threadOf(requestId);
    expect(id).toBeDefined();
    return id as string;
  }

  it("resumes the same thread when the worker is replaced under it", async () => {
    const before = new Bridge();
    before.start();
    const first = await runOnce(before, "t1");

    // A fresh Bridge is exactly what a restarted worker boots with: every
    // in-memory field back to its initial value.
    const after = new Bridge();
    after.start();

    expect(await runOnce(after, "t2")).toBe(first);
  });

  it("starts a new thread only when new_conversation asks for one", async () => {
    const bridge = new Bridge();
    bridge.start();
    const first = await runOnce(bridge, "t1");

    socketHandlers.onMessage?.({
      type: "request",
      requestId: "reset",
      method: "newConversation",
      params: {},
    });
    await vi.waitFor(() =>
      expect(sendSpy.mock.calls.some(([m]) => m?.requestId === "reset")).toBe(true),
    );

    expect(await runOnce(bridge, "t2")).not.toBe(first);
  });
});

/**
 * A screenshot of a tab nobody can see used to fail: captureVisibleTab only
 * reads what is on screen, and a background run works off screen. While the
 * debugger holds a tab, that tab is the one worth looking at.
 */
describe("Bridge screenshot", () => {
  const shoot = async (requestId: string) => {
    const bridge = new Bridge();
    bridge.start();
    socketHandlers.onMessage?.({ type: "request", requestId, method: "screenshot", params: {} });
    await vi.waitFor(() =>
      expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ requestId })),
    );
    const call = sendSpy.mock.calls.find(
      (c) => (c[0] as { requestId?: string }).requestId === requestId,
    );
    return (call?.[0] as { result: unknown }).result;
  };

  it("looks at the tab the debugger holds, even when it is off screen", async () => {
    attachedTabId = 9;
    expect(await shoot("s1")).toEqual({
      dataUrl: "data:image/jpeg;base64,CC==",
      tabId: 9,
      title: "Form",
      url: "https://y.test/",
      driven: false,
    });
  });

  it("falls back to the tab on screen when nothing is attached", async () => {
    expect(await shoot("s2")).toMatchObject({ tabId: 7, data: "data:image/jpeg;base64,AA==" });
  });
});
