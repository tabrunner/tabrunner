import { describe, it, expect, beforeEach, vi } from "vitest";
import { revealTab } from "../focus-tab";

/**
 * The chip's click. A tab id is the fast path and the stale one — chips outlive
 * the tabs they name — so what matters here is what happens after it fails.
 */

interface TabRecord {
  id: number;
  windowId: number;
  url: string;
}

let tabs: TabRecord[] = [];
const created: { url?: string; active?: boolean }[] = [];
const activated: number[] = [];

beforeEach(() => {
  tabs = [
    { id: 1, windowId: 10, url: "https://live.example/page?q=1" },
    { id: 2, windowId: 20, url: "https://other.example" },
  ];
  created.length = 0;
  activated.length = 0;
  (globalThis as Record<string, unknown>).chrome = {
    tabs: {
      get: async (id: number) => {
        const tab = tabs.find((t) => t.id === id);
        if (!tab) throw new Error(`No tab with id: ${id}.`);
        return tab;
      },
      query: async () => tabs,
      update: async (id: number) => {
        if (!tabs.some((t) => t.id === id)) throw new Error(`No tab with id: ${id}.`);
        activated.push(id);
      },
      create: async (props: { url?: string; active?: boolean }) => {
        created.push(props);
        return { id: 99, windowId: 10 };
      },
    },
    windows: { update: async () => {} },
  };
});

describe("revealTab", () => {
  it("focuses the tab while it lives — no second copy of the page", async () => {
    await revealTab({ tabId: 1, windowId: 10, url: "https://live.example/page?q=1" });

    expect(activated).toEqual([1]);
    expect(created).toEqual([]);
  });

  it("reopens the page when the tab is gone", async () => {
    await revealTab({ tabId: 42, windowId: 10, url: "https://closed.example/thing" });

    expect(created).toEqual([{ url: "https://closed.example/thing", active: true }]);
  });

  it("adopts a tab already on that page instead of piling up duplicates", async () => {
    // The user reopened it themselves (⌘⇧T), or an earlier click did — the chip
    // stays clickable forever, so forever must not mean a drawer of copies.
    await revealTab({ tabId: 42, url: "https://live.example/page?q=1" });

    expect(activated).toEqual([1]);
    expect(created).toEqual([]);
  });

  it("a stored tab with no id at all still opens its page", async () => {
    await revealTab({ url: "https://closed.example/thing" });

    expect(created).toEqual([{ url: "https://closed.example/thing", active: true }]);
  });

  it("no page to stand in for the dead tab: nothing happens, nothing throws", async () => {
    await expect(revealTab({ tabId: 42 })).resolves.toBeUndefined();
    expect(created).toEqual([]);
  });

  it("a create Chrome refuses is swallowed — a chip click never throws", async () => {
    const chromeStub = (globalThis as Record<string, unknown>).chrome as {
      tabs: { create: () => Promise<unknown> };
    };
    chromeStub.tabs.create = vi.fn(async () => {
      throw new Error("Cannot create tab");
    });

    await expect(revealTab({ url: "https://closed.example/thing" })).resolves.toBeUndefined();
  });
});
