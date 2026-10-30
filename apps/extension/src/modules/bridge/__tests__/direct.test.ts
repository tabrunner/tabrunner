import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireRun, getOwnerRun, listActiveRuns, releaseRun } from "@/modules/agent/active-runs";
import { cancelQueued, listQueue } from "@/modules/agent/run-queue";
import type { ToolResult } from "@/modules/agent/tools";
import type { DriverOptions, TabInfo } from "@/modules/browser/driver";

const executeTool = vi.fn<(...args: unknown[]) => Promise<ToolResult>>();
const waitForLoad = vi.fn();
const showIndicator = vi.fn(() => Promise.resolve());
const hideIndicator = vi.fn(() => Promise.resolve());
const releaseBrowser = vi.fn<(ownerId: string) => Promise<void>>();
const openConversation = vi.fn(() => Promise.resolve());
const claims = new Map<number, string>();
const storedTabs = new Map<string, { tabId: number; title: string; url: string }[]>();
const drivers: DriverOptions[] = [];
const sessions: InstanceType<typeof DirectSession>[] = [];
const created: string[] = [];
const removed: number[] = [];
const removedListeners = new Set<(tabId: number) => void>();
let nextTab = 42;
let queried = 0;

vi.mock("@/modules/agent/tools", () => ({
  executeTool: (...args: unknown[]) => executeTool(...args),
  formatSuccessSummary: () => "did the thing",
  formatDetail: () => undefined,
}));
vi.mock("@/modules/browser", () => ({
  createDriver: (_tabId: number, options: DriverOptions) => {
    drivers.push(options);
    return {};
  },
  claimTab: (ownerId: string, tabId: number) => {
    if (claims.has(tabId) && claims.get(tabId) !== ownerId) throw new Error("tab in use");
    claims.set(tabId, ownerId);
  },
  releaseBrowserOwner: (ownerId: string) => releaseBrowser(ownerId),
  showAgentIndicator: () => showIndicator(),
  hideAgentIndicator: () => hideIndicator(),
  isRestrictedUrl: (url?: string) => url?.startsWith("chrome://") ?? false,
  waitForLoad: (...args: unknown[]) => waitForLoad(...args),
}));
vi.mock("@/modules/conversation", () => ({
  appendMessageTo: () => Promise.resolve(),
  openAgentConversation: () => openConversation(),
  getThreadTabsFor: (conversationId: string) =>
    Promise.resolve({ tabs: storedTabs.get(conversationId) ?? [] }),
  recordDrivenTabFor: (
    conversationId: string,
    tab: { tabId: number; title: string; url: string },
  ) => {
    storedTabs.set(conversationId, [tab]);
    return Promise.resolve();
  },
}));

const { DirectSession } = await import("../direct");
const ON_SCREEN = { background: false };

function session(clientId = "a", onClose?: () => void) {
  const direct = new DirectSession(clientId, onClose);
  sessions.push(direct);
  return direct;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  sessions.length = 0;
  created.length = 0;
  removed.length = 0;
  removedListeners.clear();
  drivers.length = 0;
  claims.clear();
  storedTabs.clear();
  queried = 0;
  nextTab = 42;
  waitForLoad.mockReset().mockResolvedValue(undefined);
  executeTool.mockReset().mockResolvedValue({ ok: true, data: { pageContent: "[ref=e1] button" } });
  openConversation.mockReset().mockResolvedValue(undefined);
  showIndicator.mockClear();
  hideIndicator.mockClear();
  releaseBrowser.mockReset().mockImplementation((ownerId) => {
    for (const [tabId, owner] of claims) if (owner === ownerId) claims.delete(tabId);
    return Promise.resolve();
  });
  Object.assign(chrome, {
    tabs: {
      query: () => {
        queried++;
        return Promise.resolve([{ id: 7, windowId: 1, title: "Inbox", url: "https://user.test/" }]);
      },
      create: ({ url }: { url: string }) => {
        created.push(url);
        return Promise.resolve({ id: nextTab++ });
      },
      get: (id: number) =>
        Promise.resolve({ id, windowId: 1, title: "App", url: "https://app.test/" }),
      remove: (id: number) => {
        removed.push(id);
        return Promise.resolve();
      },
      onRemoved: {
        addListener: (listener: (tabId: number) => void) => removedListeners.add(listener),
        removeListener: (listener: (tabId: number) => void) => removedListeners.delete(listener),
      },
    },
  });
});

afterEach(async () => {
  for (const entry of listQueue()) cancelQueued(entry.id);
  for (const direct of sessions) await direct.end();
  for (const run of listActiveRuns()) releaseRun(run);
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("DirectSession ownership", () => {
  it("claims the chosen tab before the indicator and uses its run ID in the driver", async () => {
    const direct = session();
    showIndicator.mockImplementationOnce(() => {
      expect(claims.get(7)).toBe(direct.run?.id);
      return Promise.resolve();
    });
    const result = await direct.start("find the invoice", "Editor", ON_SCREEN, "chat-a");
    expect(result.ok).toBe(true);
    expect(direct.drivenTab).toBe(7);
    expect(drivers[0]?.ownerId).toBe(direct.run?.id);
    expect(executeTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "snapshot" }),
      expect.anything(),
      expect.objectContaining({ signal: direct.run?.controller.signal }),
    );
  });

  it("allows another owner but refuses a second task for this client", async () => {
    acquireRun("panel-chat", "panel", "panel");
    const a = session("a");
    const b = session("b");
    await a.start("first goal", "Editor", { background: true }, "chat-a");
    await b.start("second goal", "Editor", { background: true }, "chat-b");
    expect(listActiveRuns()).toHaveLength(3);
    await expect(a.start("another goal", "Editor", ON_SCREEN, "chat-a")).rejects.toThrow(/MCP/);
  });

  it("refuses another owner's tab without changing their browser claim", async () => {
    const a = session("a");
    const b = session("b");
    await a.start("first goal", "Editor", ON_SCREEN, "chat-a");
    await expect(b.start("second goal", "Editor", ON_SCREEN, "chat-b")).rejects.toThrow(
      "tab in use",
    );
    expect(getOwnerRun("bridge", "b")).toBeNull();
    expect(claims.get(7)).toBe(a.run?.id);
  });

  it("aborts immediately but holds claims until an in-flight action and cleanup drain", async () => {
    const direct = session();
    await direct.start("a goal", "Editor", ON_SCREEN, "chat-a");
    const run = direct.run;
    const actionResult = deferred<ToolResult>();
    executeTool.mockImplementationOnce(() => actionResult.promise);
    const action = direct.act("click", { ref: "e1" });
    await vi.advanceTimersByTimeAsync(0);
    const ending = direct.end();
    expect(run?.controller.signal.aborted).toBe(true);
    expect(getOwnerRun("bridge", "a")).toBe(run);
    expect(releaseBrowser).not.toHaveBeenCalled();
    actionResult.resolve({ ok: true });
    await action;
    await ending;
    expect(getOwnerRun("bridge", "a")).toBeNull();
    expect(releaseBrowser).toHaveBeenCalledExactlyOnceWith(run?.id);
    expect(executeTool).toHaveBeenCalledTimes(2);
  });

  it("does not release the run before asynchronous browser cleanup finishes", async () => {
    const direct = session();
    await direct.start("a goal", "Editor", ON_SCREEN, "chat-a");
    const cleanup = deferred<void>();
    releaseBrowser.mockImplementationOnce(() => cleanup.promise);
    const ending = direct.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(getOwnerRun("bridge", "a")).not.toBeNull();
    cleanup.resolve();
    await ending;
    expect(getOwnerRun("bridge", "a")).toBeNull();
  });

  it("cleans up an outer start failure and leaves other owners alone", async () => {
    const a = session("a");
    await a.start("first goal", "Editor", { background: true }, "chat-a");
    const b = session("b");
    openConversation.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(b.start("second goal", "Editor", { background: true }, "chat-b")).rejects.toThrow(
      "storage unavailable",
    );
    expect(getOwnerRun("bridge", "b")).toBeNull();
    expect(getOwnerRun("bridge", "a")?.id).toBe(a.run?.id);
    expect(claims.get(42)).toBe(a.run?.id);
  });

  it("drains only the removed tab's owner before allowing the same client to start again", async () => {
    const a = session("a");
    const b = session("b");
    await a.start("first goal", "Editor", { background: true }, "chat-a");
    await b.start("second goal", "Editor", { background: true }, "chat-b");
    const oldRun = a.run;
    const pending = deferred<ToolResult>();
    executeTool.mockImplementationOnce(() => pending.promise);
    const action = a.act("click", { ref: "e1" });
    await vi.advanceTimersByTimeAsync(0);
    for (const listener of removedListeners) listener(42);
    await vi.advanceTimersByTimeAsync(0);
    expect(oldRun?.controller.signal.aborted).toBe(true);
    expect(getOwnerRun("bridge", "a")).toBe(oldRun);
    expect(claims.get(42)).toBe(oldRun?.id);
    expect(b.run?.controller.signal.aborted).toBe(false);
    pending.resolve({ ok: false, error: "The tab closed" });
    expect(await action).toEqual({ ok: false, error: "The tab closed" });
    await vi.advanceTimersByTimeAsync(0);
    expect(a.open).toBe(false);
    expect(getOwnerRun("bridge", "a")).toBeNull();
    expect(claims.has(42)).toBe(false);
    expect(claims.get(43)).toBe(b.run?.id);
    expect(removedListeners.size).toBe(1);
    await a.start("next goal", "Editor", { background: true }, "chat-a");
    expect(a.run?.id).not.toBe(oldRun?.id);
    expect(b.open).toBe(true);
  });

  it("expires idle sessions but does not expire under a long action", async () => {
    const onClose = vi.fn();
    const direct = session("a", onClose);
    await direct.start("a goal", "Editor", ON_SCREEN, "chat-a");
    const pending = deferred<ToolResult>();
    executeTool.mockImplementationOnce(() => pending.promise);
    const action = direct.act("click", {}, false);
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    expect(direct.run?.controller.signal.aborted).toBe(false);
    pending.resolve({ ok: true });
    await action;
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    expect(direct.open).toBe(false);
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("DirectSession page results", () => {
  it("re-snapshots after a mutation and merges the fresh page with its result", async () => {
    const direct = session();
    await direct.start("a goal", "Editor", ON_SCREEN, "chat-a");
    executeTool.mockClear();
    executeTool.mockResolvedValueOnce({ ok: true, data: { x: 1, y: 2 } });
    executeTool.mockResolvedValueOnce({ ok: true, data: { pageContent: "new page" } });
    expect((await direct.act("click", { ref: "e1" })).data).toEqual({
      x: 1,
      y: 2,
      pageContent: "new page",
    });
    expect(executeTool).toHaveBeenCalledTimes(2);
  });

  it("skips the extra snapshot for reads and explicit snapshot:false", async () => {
    const direct = session();
    await direct.start("a goal", "Editor", ON_SCREEN, "chat-a");
    executeTool.mockClear();
    await direct.act("list_tabs", {});
    await direct.act("click", { ref: "e1" }, false);
    expect(executeTool).toHaveBeenCalledTimes(2);
  });

  it("opens its own page by default and never queries the user's tab", async () => {
    const direct = session();
    await direct.start("a goal", "Editor", { background: true }, "chat-a");
    expect(created).toEqual(["https://www.google.com"]);
    expect(direct.drivenTab).toBe(42);
    expect(queried).toBe(0);
  });

  it("uses an explicit URL even when background is false", async () => {
    const direct = session();
    await direct.start(
      "a goal",
      "Editor",
      { url: "https://example.test/", background: false },
      "chat-a",
    );
    expect(created).toEqual(["https://example.test/"]);
    expect(queried).toBe(0);
  });

  it("closes a new tab that never loads and releases its run", async () => {
    waitForLoad.mockRejectedValueOnce(new Error("slow page"));
    const direct = session();
    await expect(direct.start("a goal", "Editor", { background: true }, "chat-a")).rejects.toThrow(
      "slow page",
    );
    expect(removed).toEqual([42]);
    expect(getOwnerRun("bridge", "a")).toBeNull();
  });

  it("closes an unused starter but resumes a page the same client acted on", async () => {
    const direct = session();
    await direct.start("first goal", "Editor", { background: true }, "chat-a");
    await direct.end();
    expect(removed).toEqual([42]);
    await direct.start("second goal", "Editor", { background: true }, "chat-a");
    await direct.act("navigate", { url: "https://app.test/" }, false);
    await direct.end();
    await direct.start("follow up", "Editor", { background: true }, "chat-a");
    expect(created).toHaveLength(2);
    expect(direct.drivenTab).toBe(43);
  });

  it("awaits tab-switch indicators and records the newly driven tab", async () => {
    const direct = session();
    await direct.start("a goal", "Editor", ON_SCREEN, "chat-a");
    const tab: TabInfo = {
      id: 8,
      windowId: 1,
      title: "Next",
      url: "https://next.test/",
      active: false,
    };
    await drivers[0]?.onSwitch?.(tab);
    expect(direct.drivenTab).toBe(8);
    await direct.end();
    expect(storedTabs.get("chat-a")?.[0]?.tabId).toBe(8);
  });
});
