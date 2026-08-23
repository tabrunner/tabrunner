import { describe, it, expect, vi, beforeEach } from "vitest";

// @/i18n (pulled in via cdp-driver) reads wxt storage at module scope — no chrome in tests.
vi.mock("wxt/utils/storage", () => ({
  storage: {
    defineItem: (_key: string, opts?: { fallback?: unknown }) => {
      let value: unknown = opts?.fallback ?? null;
      return {
        getValue: async () => value,
        setValue: async (v: unknown) => void (value = v),
        removeValue: async () => void (value = null),
        watch: () => () => {},
      };
    },
  },
}));

// Observe which tab the driver snapshots — the re-target is the whole point of switch_tab.
vi.mock("../snapshot", () => ({
  captureSnapshot: vi.fn(async (tabId: number) => ({ pageContent: `snap:${tabId}` })),
  resolveRefRect: vi.fn(),
}));

interface TabRecord {
  id: number;
  windowId: number;
  title?: string;
  url?: string;
  active?: boolean;
}
const tabs: Record<number, TabRecord> = {
  1: { id: 1, windowId: 10, title: "First", url: "https://a.example" },
  2: { id: 2, windowId: 10, title: "Second", url: "https://b.example" },
  3: { id: 3, windowId: 20, title: "Elsewhere", url: "https://c.example" },
  4: { id: 4, windowId: 10, title: "Mine", url: "https://mine.example" },
};
/** The one live tab group, sitting in window 10 with tabs 1-2. */
const groups: Record<number, { windowId: number }> = { 7: { windowId: 10 } };
const updates: { id?: number; window?: number; props: Record<string, unknown> }[] = [];
const groupCalls: { tabIds: number | number[]; groupId?: number }[] = [];

/** What Chrome does on { active: true }: the tab's window gets one active tab. */
function setActive(id: number) {
  const t = tabs[id];
  if (!t) return;
  for (const s of Object.values(tabs)) if (s.windowId === t.windowId) s.active = false;
  t.active = true;
}

// The chrome stub must exist before driver/cdp-driver import — cdp-driver
// registers its listeners at module scope.
(globalThis as Record<string, unknown>).chrome = {
  tabs: {
    onRemoved: { addListener: () => {}, removeListener: () => {} },
    onUpdated: { addListener: () => {}, removeListener: () => {} },
    get: async (id: number) => {
      const t = tabs[id];
      if (!t) throw new Error(`No tab with id: ${id}`);
      return t;
    },
    update: async (id: number, props: Record<string, unknown>) => {
      updates.push({ id, props });
      if (props.active === true) setActive(id);
      return tabs[id];
    },
    query: async (q: { active?: boolean; windowId?: number } = {}) =>
      Object.values(tabs).filter(
        (t) =>
          (q.windowId === undefined || t.windowId === q.windowId) &&
          (q.active !== true || t.active === true),
      ),
    group: async (opts: { tabIds: number | number[]; groupId?: number }) => {
      groupCalls.push(opts);
      return opts.groupId ?? 42;
    },
  },
  tabGroups: {
    get: async (id: number) => {
      const g = groups[id];
      if (!g) throw new Error(`No group with id: ${id}`);
      return g;
    },
  },
  windows: {
    update: async (windowId: number, props: Record<string, unknown>) => {
      updates.push({ window: windowId, props });
    },
  },
  debugger: {
    onDetach: { addListener: () => {} },
    onEvent: { addListener: () => {} },
  },
};

const { createDriver } = await import("../driver");
const { focusTab } = await import("../focus-tab");

describe("driver tab switching", () => {
  beforeEach(() => {
    updates.length = 0;
    groupCalls.length = 0;
    for (const t of Object.values(tabs)) t.active = false;
  });

  it("focusTab pulls the window by default — the pull belongs to the user's own clicks", async () => {
    await focusTab(2, 10);
    expect(updates).toEqual([
      { window: 10, props: { focused: true } },
      { id: 2, props: { active: true } },
    ]);
  });

  it("switchTab follows on screen while the user watches the tab being left", async () => {
    tabs[1]!.active = true; // the user is on the run's tab
    const switches: number[] = [];
    const driver = createDriver(1, { onSwitch: (info) => switches.push(info.id) });

    await expect(driver.snapshot()).resolves.toMatchObject({ pageContent: "snap:1" });

    const info = await driver.switchTab(2);
    expect(info).toMatchObject({ id: 2, title: "Second", active: true });
    expect(switches).toEqual([2]);
    // The tab activates, but the window is never pulled — the agent's moves
    // must not yank Chrome out of another app (that pull is the user's chips).
    expect(updates).toEqual([{ id: 2, props: { active: true } }]);

    await expect(driver.snapshot()).resolves.toMatchObject({ pageContent: "snap:2" });
  });

  it("stops following once the user moves to a tab of their own", async () => {
    tabs[1]!.active = true;
    const driver = createDriver(1);

    await driver.switchTab(2); // followed: the user was watching tab 1
    expect(updates).toEqual([{ id: 2, props: { active: true } }]);

    // The user wanders off to their own tab — the next switch is silent.
    setActive(4);
    const info = await driver.switchTab(1);
    expect(info).toMatchObject({ id: 1, active: false });
    expect(updates).toHaveLength(1);

    // …but the re-target still happened.
    await expect(driver.snapshot()).resolves.toMatchObject({ pageContent: "snap:1" });
  });

  it("re-targets without taking the browser away once nobody is watching", async () => {
    tabs[1]!.active = true; // even a user on the run's tab is left alone
    // The panel closed mid-run: the predicate is asked at the switch, not at
    // run start, so walking away silences the follow from that moment on.
    const driver = createDriver(1, { activateOnSwitch: () => false });

    const info = await driver.switchTab(2);
    expect(info).toMatchObject({ id: 2, active: false });
    expect(updates).toEqual([]); // no tab activation, no window focus

    await expect(driver.snapshot()).resolves.toMatchObject({ pageContent: "snap:2" });
  });

  it("a dead tab id throws and leaves the current target untouched", async () => {
    const driver = createDriver(1);
    await expect(driver.switchTab(99)).rejects.toThrow("No tab with id: 99");
    await expect(driver.snapshot()).resolves.toMatchObject({ pageContent: "snap:1" });
  });

  it("listTabs reports every open tab", async () => {
    const driver = createDriver(1);
    const listed = await driver.listTabs();
    expect(listed.map((t) => t.id)).toEqual([1, 2, 3, 4]);
    expect(listed[0]).toMatchObject({ title: "First", url: "https://a.example", active: false });
  });

  it("groupTab files a tab into the run's group without retargeting the driver", async () => {
    const driver = createDriver(1);
    const info = await driver.groupTab(2, 7);
    expect(info).toMatchObject({ id: 2, title: "Second" });
    expect(groupCalls).toEqual([{ tabIds: 2, groupId: 7 }]);
    // Filing is organization, not a drive — the target stays on the run's tab.
    await expect(driver.snapshot()).resolves.toMatchObject({ pageContent: "snap:1" });
  });

  it("groupTab refuses a tab in another window — groups can't span windows", async () => {
    const driver = createDriver(1);
    await expect(driver.groupTab(3, 7)).rejects.toThrow("another window");
    expect(groupCalls).toEqual([]);
  });

  it("groupTab surfaces a dead group or tab as a thrown error", async () => {
    const driver = createDriver(1);
    await expect(driver.groupTab(2, 99)).rejects.toThrow("No group with id: 99");
    await expect(driver.groupTab(99, 7)).rejects.toThrow("No tab with id: 99");
  });
});
