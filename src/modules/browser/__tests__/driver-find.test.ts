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

const snapshotLines = [
  'heading "Order history"',
  'link "Invoice #1042" [ref=e3] href="/invoices/1042"',
  'button "Download PDF" [ref=e4]',
  'link "Invoice #1031" [ref=e5] href="/invoices/1031"',
];

vi.mock("../snapshot", () => ({
  captureSnapshot: vi.fn(async () => ({
    pageContent: snapshotLines.join("\n"),
    url: "https://shop.example/orders",
  })),
  resolveRefPoint: vi.fn(),
}));

// openTab goes through switchTab → focusTab → waitForLoad; all real chrome
// surfaces are stubbed below.
vi.mock("../indicator", () => ({ refreshAgentIndicator: vi.fn(async () => {}) }));

const removed: number[] = [];
const created: { url?: string; active?: boolean }[] = [];
let nextTabId = 10;

(globalThis as Record<string, unknown>).chrome = {
  runtime: { getPlatformInfo: async () => ({ os: "mac" }) },
  tabs: {
    onRemoved: { addListener: () => {}, removeListener: () => {} },
    onUpdated: { addListener: () => {}, removeListener: () => {} },
    get: async (id: number) => {
      if (id === 1) return { id: 1, windowId: 10, title: "Orders", url: "https://shop.example" };
      if (id === 2)
        return { id: 2, windowId: 10, title: "Invoice #1042", url: "https://shop.example/i/1042" };
      if (id === nextTabId - 1)
        return { id, windowId: 10, title: "New", url: created.at(-1)?.url ?? "" };
      throw new Error(`No tab with id: ${id}`);
    },
    create: async (opts: { url?: string; active?: boolean }) => {
      created.push(opts);
      return { id: nextTabId++, status: "complete", url: opts.url ?? "" };
    },
    update: async () => ({}),
    remove: async (id: number) => {
      removed.push(id);
    },
    query: async () => [],
  },
  tabGroups: {},
  windows: { update: async () => ({}) },
  debugger: {
    onDetach: { addListener: () => {} },
    onEvent: { addListener: () => {} },
    attach: async () => {},
    sendCommand: async () => ({}),
  },
};

const { createDriver } = await import("../driver");

describe("driver.find", () => {
  it("returns the matching snapshot lines, trimmed, with their refs", async () => {
    const driver = createDriver(1);
    const result = await driver.find("invoice");
    expect(result).toMatchObject({ query: "invoice", total: 2 });
    expect(result.matches).toEqual([
      'link "Invoice #1042" [ref=e3] href="/invoices/1042"',
      'link "Invoice #1031" [ref=e5] href="/invoices/1031"',
    ]);
  });

  it("matches case-insensitively and reports zero cleanly", async () => {
    const driver = createDriver(1);
    const result = await driver.find("DOWNLOAD");
    expect(result.total).toBe(1);
    const none = await driver.find("unicorn");
    expect(none).toMatchObject({ matches: [], total: 0 });
  });
});

describe("driver.closeTab", () => {
  beforeEach(() => {
    removed.length = 0;
  });

  it("refuses to close the tab it is driving", async () => {
    const driver = createDriver(1);
    await expect(driver.closeTab(1)).rejects.toThrow(/driving/);
    expect(removed).toEqual([]);
  });

  it("closes any other tab and returns what it was — the row names what closed", async () => {
    const driver = createDriver(1);
    const closed = await driver.closeTab(2);
    expect(closed).toMatchObject({ id: 2, title: "Invoice #1042" });
    expect(removed).toEqual([2]);
  });

  it("surfaces a dead tab id as a thrown error, and removes nothing", async () => {
    const driver = createDriver(1);
    await expect(driver.closeTab(99)).rejects.toThrow("No tab with id: 99");
    expect(removed).toEqual([]);
  });
});
