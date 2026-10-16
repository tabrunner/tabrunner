import { describe, it, expect, vi, beforeEach } from "vitest";

// @/i18n (pulled in via cdp-driver) reads wxt storage at module scope — no chrome in tests.
vi.mock("wxt/utils/storage", () => ({
  storage: {
    defineItem: (_key: string, opts?: { fallback?: unknown }) => ({
      getValue: async () => opts?.fallback ?? null,
      setValue: async () => {},
      removeValue: async () => {},
      watch: () => () => {},
    }),
  },
}));

vi.mock("../indicator", () => ({ refreshAgentIndicator: vi.fn(async () => {}) }));

interface TabStub {
  id: number;
  windowId: number;
  url: string;
  status: string;
}
type Listener = (id: number, info: { status?: string }, tab: TabStub) => void;
type RemovedListener = (id: number) => void;

const tab: TabStub = { id: 1, windowId: 10, url: "https://example.com", status: "complete" };
const listeners = new Set<Listener>();
const removedListeners = new Set<RemovedListener>();
/** Set to close the tab out from under a caller, the way a page or the user can. */
let closed = false;

const runtime = { lastError: undefined as { message: string } | undefined };

(globalThis as Record<string, unknown>).chrome = {
  runtime,
  tabs: {
    onRemoved: {
      addListener: (fn: RemovedListener) => removedListeners.add(fn),
      removeListener: (fn: RemovedListener) => removedListeners.delete(fn),
    },
    onUpdated: {
      addListener: (fn: Listener) => listeners.add(fn),
      removeListener: (fn: Listener) => listeners.delete(fn),
    },
    // Both callers use the callback form Chrome offers alongside the promise
    // one, including how it answers a dead id: undefined, plus lastError. The
    // promise comes back ONLY when no callback is passed — returning a rejected
    // one alongside a callback would surface as an unhandled rejection the real
    // API never produces.
    get: (_id: number, cb?: (t: TabStub | undefined) => void) => {
      if (!cb)
        return closed ? Promise.reject(new Error("No tab with id: 1.")) : Promise.resolve(tab);
      queueMicrotask(() => {
        runtime.lastError = closed ? { message: "No tab with id: 1." } : undefined;
        cb(closed ? undefined : tab);
        runtime.lastError = undefined;
      });
      return undefined;
    },
  },
  debugger: { onDetach: { addListener: () => {} }, onEvent: { addListener: () => {} } },
};

const { settleIfLoading, waitForLoad } = await import("../cdp-driver");

/** Let every pending microtask and 0ms timer drain. */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** What Chrome does on a status change: the tab moves, then listeners hear it. */
async function emit(status: string) {
  tab.status = status;
  for (const fn of [...listeners]) fn(tab.id, { status }, tab);
  await flush();
}

/** What Chrome does when a tab goes away — including under a pending wait. */
async function close() {
  closed = true;
  for (const fn of [...removedListeners]) fn(tab.id);
  await flush();
}

/** Nothing left subscribed on either channel — no listener outlives its call. */
const subscribed = () => listeners.size + removedListeners.size;

describe("settleIfLoading", () => {
  beforeEach(() => {
    listeners.clear();
    removedListeners.clear();
    tab.status = "complete";
    closed = false;
  });

  it("reports no load when the window passes quietly — the common click", async () => {
    await expect(settleIfLoading(1, 20)).resolves.toBe(false);
    expect(subscribed()).toBe(0);
  });

  it("rides out a load that starts inside the window", async () => {
    let settled: boolean | undefined;
    const settling = settleIfLoading(1, 1000).then((v) => (settled = v));

    await emit("loading");
    // Seeing the load start is not the point — arriving after it finishes is.
    expect(settled).toBeUndefined();

    await emit("complete");
    await settling;
    expect(settled).toBe(true);
    expect(subscribed()).toBe(0);
  });

  it("catches a load already in flight when the action's promise settles", async () => {
    tab.status = "loading";
    let settled: boolean | undefined;
    const settling = settleIfLoading(1, 20).then((v) => (settled = v));
    await flush();
    // The window has long expired by now; the load was seen on entry, not by event.
    await new Promise((r) => setTimeout(r, 40));
    expect(settled).toBeUndefined();

    await emit("complete");
    await settling;
    expect(settled).toBe(true);
    expect(subscribed()).toBe(0);
  });

  it("gives up at once on a tab that is already gone", async () => {
    closed = true;
    // Not "waits out the window and then says no" — a closed tab has nothing to
    // settle, and the call behind this one is what reports it.
    const before = Date.now();
    await expect(settleIfLoading(1, 5_000)).resolves.toBe(false);
    expect(Date.now() - before).toBeLessThan(1_000);
    expect(subscribed()).toBe(0);
  });

  it("does not hold the batch for the load timeout when the tab dies mid-load", async () => {
    tab.status = "loading";
    // The load is seen on entry, so waitForLoad takes over — and a tab that
    // closes now never reaches "complete". Without onRemoved the only thing
    // that ends this is waitForLoad's own 30s timeout, stalling the batch.
    const settling = settleIfLoading(1, 20);
    await flush();

    const before = Date.now();
    await close();
    await expect(settling).resolves.toBe(true);
    expect(Date.now() - before).toBeLessThan(1_000);
    expect(subscribed()).toBe(0);
  });
});

// These reach the person (and the MCP client) as the run's error, so they are
// catalog text in the user's language, not a code string.
describe("waitForLoad errors", () => {
  beforeEach(() => {
    listeners.clear();
    removedListeners.clear();
    tab.status = "loading";
    closed = false;
  });

  it("says how long it waited and what to do, in the catalog's words", async () => {
    await expect(waitForLoad(1, 20)).rejects.toThrow(
      "The page did not finish loading in 0.02 seconds. It may be slow, or this computer may be busy. Try again.",
    );
  });

  it("names a tab that closed mid-load", async () => {
    const outcome = expect(waitForLoad(1, 5_000)).rejects.toThrow(
      "The tab was closed before its page finished loading.",
    );
    await flush();
    await close();
    await outcome;
  });

  it("names a tab that is already gone", async () => {
    closed = true;
    await expect(waitForLoad(1)).rejects.toThrow("That tab is gone.");
  });
});
