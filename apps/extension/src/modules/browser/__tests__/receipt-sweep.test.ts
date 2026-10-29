import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// @/i18n and the widgetHidden pref read wxt storage at module scope.
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

import {
  drivenTabs,
  paintWidget,
  reconcileStatusWidgets,
  removeWidget,
  settleStatusWidgets,
} from "../status-widget";

/**
 * The floor under the receipt's page-side timer. A frozen background tab runs
 * no timers at all, so "Task finished" can outstay its run by however long the
 * user is away — coming back to the tab has to be an exit of its own.
 */

const injected: { tabId: number; func: unknown }[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  injected.length = 0;
  drivenTabs.clear();
  (globalThis as Record<string, unknown>).chrome = {
    tabs: {
      query: async () => [
        { id: 1, windowId: 10, url: "https://a.example" },
        { id: 2, windowId: 20, url: "https://b.example" },
      ],
    },
    scripting: {
      executeScript: async ({ target, func }: { target: { tabId: number }; func: unknown }) => {
        injected.push({ tabId: target.tabId, func });
        return [];
      },
    },
  };
});

afterEach(() => vi.useRealTimers());

const removals = () => injected.filter((i) => i.func === removeWidget).map((i) => i.tabId);
const paints = () => injected.filter((i) => i.func === paintWidget).map((i) => i.tabId);

describe("stale receipts", () => {
  it("survive the first look and go on the next", async () => {
    await settleStatusWidgets("done");
    expect(paints()).toEqual([1, 2]);

    // Straight away the receipt is still being read — switching tabs must not
    // snatch it away before it has said anything.
    await reconcileStatusWidgets();
    expect(removals()).toEqual([]);

    vi.advanceTimersByTime(6000);
    await reconcileStatusWidgets();
    expect(removals()).toEqual([1, 2]);

    // And only once — the note is spent.
    injected.length = 0;
    await reconcileStatusWidgets();
    expect(removals()).toEqual([]);
  });

  it("never strips a mark the next run already put up", async () => {
    await settleStatusWidgets("failed");
    // Tab 1 is being driven now: the host holds a live badge, not a receipt.
    drivenTabs.add(1);

    vi.advanceTimersByTime(6000);
    injected.length = 0;
    await reconcileStatusWidgets();

    expect(removals()).toEqual([2]);
  });
});
