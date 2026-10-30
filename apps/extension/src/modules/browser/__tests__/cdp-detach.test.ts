import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { i18n } from "@/i18n";

vi.mock("../indicator", () => ({ refreshAgentIndicator: vi.fn(async () => {}) }));

const attach = vi.fn(async (_target: { tabId: number }) => {});
const detach = vi.fn(async (_target: { tabId: number }) => {});
const sendCommand = vi.fn(
  async (_target: { tabId: number }, _method: string, _params?: Record<string, unknown>) => ({}),
);

(globalThis as Record<string, unknown>).chrome = {
  tabs: {
    onRemoved: { addListener: () => {}, removeListener: () => {} },
    onUpdated: { addListener: () => {}, removeListener: () => {} },
  },
  debugger: {
    onDetach: { addListener: () => {} },
    onEvent: { addListener: () => {} },
    attach,
    detach,
    sendCommand,
  },
};

const { ensureAttached, releaseBrowserOwner, claimTab, tabOwner, isAttached, clickAt } =
  await import("../cdp-driver");
const { createDriver } = await import("../driver");

beforeEach(() => {
  attach.mockClear();
  detach.mockClear();
  sendCommand.mockClear();
});
afterEach(async () => {
  await Promise.all([releaseBrowserOwner("a"), releaseBrowserOwner("b")]);
});

describe("browser ownership", () => {
  it("claims before attach and refuses another owner's initial, switched, closed or grouped tab", async () => {
    const driver = createDriver(1, { ownerId: "a" });
    claimTab("b", 2);
    expect(tabOwner(1)).toBe("a");
    expect(attach).not.toHaveBeenCalled();
    expect(() => createDriver(1, { ownerId: "b" })).toThrow(
      i18n.t("errors.tabInUse", { tabId: 1 }),
    );
    await expect(driver.switchTab(2)).rejects.toThrow(i18n.t("errors.tabInUse", { tabId: 2 }));
    await expect(driver.closeTab(2)).rejects.toThrow(i18n.t("errors.tabInUse", { tabId: 2 }));
    await expect(driver.groupTab(2, 5)).rejects.toThrow(i18n.t("errors.tabInUse", { tabId: 2 }));
    expect(tabOwner(2)).toBe("b");
  });

  it("detaches only this owner's tabs and permits the next owner to attach", async () => {
    await ensureAttached("a", 1);
    await ensureAttached("a", 2);
    await ensureAttached("a", 1);
    await ensureAttached("b", 3);
    expect(attach.mock.calls.map(([target]) => target.tabId)).toEqual([1, 2, 3]);

    await releaseBrowserOwner("a");
    expect(detach.mock.calls.map(([target]) => target.tabId)).toEqual([1, 2]);
    expect(isAttached(3)).toBe(true);
    expect(tabOwner(3)).toBe("b");
    expect(tabOwner(1)).toBeUndefined();
    await ensureAttached("b", 1);
    expect(attach.mock.calls.map(([target]) => target.tabId)).toEqual([1, 2, 3, 1]);
  });

  it("keeps every click event on its own tab while another owner attaches and clicks", async () => {
    await ensureAttached("a", 1);
    const pressed = Promise.withResolvers<void>();
    const continueClick = Promise.withResolvers<void>();
    sendCommand.mockImplementation(async (target, method, params) => {
      if (
        target.tabId === 1 &&
        method === "Input.dispatchMouseEvent" &&
        params?.type === "mousePressed"
      ) {
        pressed.resolve();
        await continueClick.promise;
      }
      return {};
    });
    const first = clickAt(1, 10, 20);
    await pressed.promise;
    await ensureAttached("b", 2);
    await clickAt(2, 30, 40);
    continueClick.resolve();
    await first;

    const events = sendCommand.mock.calls.filter(
      ([, method]) => method === "Input.dispatchMouseEvent",
    );
    expect(events.map(([target, , params]) => [target.tabId, params?.x, params?.y])).toEqual([
      [1, 10, 20],
      [1, 10, 20],
      [2, 30, 40],
      [2, 30, 40],
      [2, 30, 40],
      [1, 10, 20],
    ]);
    await releaseBrowserOwner("a");
    expect(isAttached(2)).toBe(true);
    sendCommand.mockImplementation(async () => ({}));
  });

  it("waits for a pending attach, deduplicates it and holds the claim through detach", async () => {
    const attaching = Promise.withResolvers<void>();
    attach.mockImplementationOnce(() => attaching.promise);
    const first = ensureAttached("a", 1);
    const second = ensureAttached("a", 1);
    const release = releaseBrowserOwner("a");
    expect(() => claimTab("b", 1)).toThrow(i18n.t("errors.tabInUse", { tabId: 1 }));
    expect(detach).not.toHaveBeenCalled();
    attaching.resolve();
    await Promise.all([first, second, release]);
    expect(attach).toHaveBeenCalledTimes(1);
    expect(detach).toHaveBeenCalledWith({ tabId: 1 });
    expect(isAttached(1)).toBe(false);
    claimTab("b", 1);
    expect(tabOwner(1)).toBe("b");
  });

  it("continues cleanup when a closed tab refuses to detach", async () => {
    await ensureAttached("a", 1);
    await ensureAttached("a", 2);
    detach.mockRejectedValueOnce(new Error("No tab with given id"));
    await expect(releaseBrowserOwner("a")).resolves.toBeUndefined();
    expect(detach).toHaveBeenCalledTimes(2);
    expect(tabOwner(1)).toBeUndefined();
    expect(tabOwner(2)).toBeUndefined();
    detach.mockClear();
    await releaseBrowserOwner("a");
    expect(detach).not.toHaveBeenCalled();
  });
});
