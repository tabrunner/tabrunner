import { describe, it, expect, vi } from "vitest";

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

const commands: Array<{ tabId: number; method: string; params?: unknown }> = [];

(globalThis as Record<string, unknown>).chrome = {
  tabs: {
    onRemoved: { addListener: () => {}, removeListener: () => {} },
    onUpdated: { addListener: () => {}, removeListener: () => {} },
  },
  debugger: {
    onDetach: { addListener: () => {} },
    onEvent: { addListener: () => {} },
    attach: async () => {},
    detach: async () => {},
    sendCommand: async (target: { tabId: number }, method: string, params?: unknown) => {
      commands.push({ tabId: target.tabId, method, params });
      return {};
    },
  },
};

const { ensureAttached, clickAt, releaseBrowserOwner } = await import("../cdp-driver");

// A tab the user cannot see is hidden to Chrome, which queues presses, keys and
// the wheel until it is shown: every action said ok and nothing happened.
describe("attach", () => {
  it("turns on focus emulation before any input can be sent", async () => {
    await ensureAttached("focus", 5);
    await clickAt(5, 10, 10);

    const methods = commands.map((c) => c.method);
    const focus = methods.indexOf("Emulation.setFocusEmulationEnabled");
    expect(focus).toBeGreaterThanOrEqual(0);
    expect(focus).toBeLessThan(methods.indexOf("Input.dispatchMouseEvent"));
    expect(commands[focus]).toMatchObject({ tabId: 5, params: { enabled: true } });
    await releaseBrowserOwner("focus");
  });

  it("asks once per attach, not once per action", async () => {
    commands.length = 0;
    await ensureAttached("focus", 6);
    await ensureAttached("focus", 6);
    await clickAt(6, 1, 1);
    await clickAt(6, 2, 2);

    expect(commands.filter((c) => c.method === "Emulation.setFocusEmulationEnabled")).toHaveLength(
      1,
    );
    await releaseBrowserOwner("focus");
  });
});
